const express  = require("express");
const crypto   = require("crypto");
const path     = require("path");
const webpush  = require("web-push");
const { Redis } = require("@upstash/redis");
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || "colptwebhook";
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN  || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const VAPID_PUBLIC    = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE   = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL     = process.env.VAPID_EMAIL       || "mailto:admin@caravanoflifetrust.org";

// Setup web-push VAPID if keys are configured
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log("✅ VAPID push notifications configured");
} else {
  console.log("⚠️  VAPID keys not set — push notifications disabled");
}

// ─── UPSTASH REDIS ───
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
console.log("✅ Upstash Redis connected");

// ─── PUSH NOTIFICATION SUBSCRIPTIONS (in-memory, per session) ───
const pushSubscriptions = {};  // username → subscription object

// Send push to all subscribed users
async function sendPushToAll(title, body, phone) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const payload = JSON.stringify({ title, body, phone });
  for (const [username, sub] of Object.entries(pushSubscriptions)) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch(err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired — remove it
        delete pushSubscriptions[username];
      }
      console.log(`Push failed for ${username}:`, err.message);
    }
  }
}

// ─── REDIS HELPERS ───

// Normalise phone: strip +, spaces, dashes
function normalisePhone(raw) {
  if (!raw) return null;
  return String(raw).replace(/[\s\-\(\)\+\.]/g, "");
}

async function getConversation(phone) {
  const p = normalisePhone(phone) || phone;
  return (await redis.get(`convo:${p}`)) || null;
}
async function saveConversation(phone, data) {
  const p = normalisePhone(phone) || phone;
  await redis.set(`convo:${p}`, data);
}
async function getAllConversations() {
  const keys = await redis.keys("convo:*");
  if (!keys.length) return [];
  const convos = await Promise.all(keys.map(k => redis.get(k)));
  return convos.filter(Boolean);
}
async function pushMessage(phone, name, message) {
  const p = normalisePhone(phone) || phone;
  let convo = await getConversation(p);
  if (!convo) convo = { phone: p, name, messages: [], tags: [], note: "" };
  // Update name only if incoming (customer's real WA name takes priority)
  if (name && name !== p) convo.name = name;
  convo.messages.push(message);
  await saveConversation(p, convo);
  return convo;
}

// ── MEDIA CACHE — store fetched buffers in Redis to avoid Meta URL expiry ──
async function getCachedMedia(mediaId) {
  try {
    const cached = await redis.get(`media:${mediaId}`);
    return cached || null; // base64 string
  } catch { return null; }
}
async function setCachedMedia(mediaId, base64Data) {
  try {
    // Cache for 7 days
    await redis.set(`media:${mediaId}`, base64Data, { ex: 7 * 24 * 60 * 60 });
  } catch {}
}

// ── REACTION HELPER — attach reaction to original message ──
async function handleReaction(phone, reactionData) {
  const p = normalisePhone(phone) || phone;
  const convo = await getConversation(p);
  if (!convo) return;
  const { message_id, emoji, react_by } = reactionData;
  const msg = convo.messages?.find(m => m.id === message_id);
  if (msg) {
    if (!msg.reactions) msg.reactions = {};
    if (emoji) {
      msg.reactions[react_by || "?"] = emoji;
    } else {
      delete msg.reactions[react_by || "?"]; // empty emoji = unreaction
    }
    await saveConversation(p, convo);
  }
}

// Update message status with timestamp

async function updateMessageStatus(msgId, status) {
  const keys = await redis.keys("convo:*");
  for (const key of keys) {
    const convo = await redis.get(key);
    if (!convo) continue;
    const msg = convo.messages?.find(m => m.id === msgId);
    if (msg) {
      msg.status = status;
      if (status === "delivered") msg.deliveredAt = new Date();
      if (status === "read")      msg.readAt      = new Date();
      await redis.set(key, convo);
      break;
    }
  }
}

// ─── PARSE USERS ───
function parseUsers() {
  const raw = process.env.USERS || "admin:admin123";
  const users = {};
  raw.split(",").forEach(pair => {
    const [u, ...rest] = pair.trim().split(":");
    if (u && rest.length) users[u.trim()] = rest.join(":").trim();
  });
  return users;
}

// ─── SESSION STORE ───
const sessions = {};
function createSession(username) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions[token] = { username, createdAt: Date.now() };
  return token;
}
function getSession(req) {
  const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!token) return null;
  const s = sessions[token];
  if (!s) return null;
  if (Date.now() - s.createdAt > 12 * 60 * 60 * 1000) { delete sessions[token]; return null; }
  return s;
}
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "Unauthorized" });
  req.user = s.username;
  next();
}

// ─── PUBLIC PAGES ───
app.get("/",         (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/app",      (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/manifest.json", (req, res) => res.sendFile(path.join(__dirname, "public", "manifest.json")));
app.get("/sw.js",    (req, res) => res.sendFile(path.join(__dirname, "public", "sw.js")));
app.get("/trh-logo.png", (req, res) => {
  const f = path.join(__dirname, "public", "trh-logo.png");
  res.sendFile(f, err => { if (err) res.status(404).send("Not found"); });
});

// ─── LOGIN / LOGOUT ───
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const users = parseUsers();
  if (users[username] && users[username] === password) {
    const token = createSession(username);
    console.log(`✅ Login: ${username}`);
    res.json({ success: true, token, username });
  } else {
    console.log(`❌ Failed login: ${username}`);
    res.status(401).json({ error: "Invalid username or password" });
  }
});
app.post("/api/logout", (req, res) => {
  const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (token && sessions[token]) { console.log(`👋 Logout: ${sessions[token].username}`); delete sessions[token]; }
  res.json({ success: true });
});

// ─── PUSH NOTIFICATION SUBSCRIPTION ───
app.post("/api/push/subscribe", requireAuth, (req, res) => {
  pushSubscriptions[req.user] = req.body;
  console.log(`🔔 Push subscription saved for ${req.user}`);
  res.json({ success: true });
});
app.delete("/api/push/subscribe", requireAuth, (req, res) => {
  delete pushSubscriptions[req.user];
  res.json({ success: true });
});
// VAPID public key endpoint
app.get("/api/push/key", (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || "" });
});

// ─── WEBHOOK VERIFICATION ───
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === VERIFY_TOKEN) { console.log("✅ Webhook verified"); res.status(200).send(challenge); }
  else res.sendStatus(403);
});

// ─── RECEIVE MESSAGES ───
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object === "whatsapp_business_account") {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;

        // ── Reactions ──
        if (value.messages) {
          for (const msg of value.messages) {
            if (msg.type === "reaction") {
              await handleReaction(msg.from, {
                message_id: msg.reaction?.message_id,
                emoji:      msg.reaction?.emoji,
                react_by:   value.contacts?.[0]?.profile?.name || msg.from
              });
              console.log(`😄 Reaction from ${msg.from}: ${msg.reaction?.emoji}`);
              continue;
            }
            const from = msg.from;
            const name = value.contacts?.[0]?.profile?.name || from;
            let text, mediaId, mediaType, fileName, mimeType;

            if (msg.type === "text") {
              text = msg.text.body;
            } else if (msg.type === "button") {
              text = msg.button?.text || "[button]";
            } else if (msg.type === "interactive") {
              const ir = msg.interactive;
              if      (ir?.type === "button_reply") text = ir.button_reply?.title || "[button reply]";
              else if (ir?.type === "list_reply")   text = ir.list_reply?.title   || "[list reply]";
              else text = "[interactive]";
            } else if (msg.type === "image") {
              text = "📷 Image";
              mediaId   = msg.image?.id;
              mimeType  = msg.image?.mime_type;
              mediaType = "image";
            } else if (msg.type === "audio") {
              text = "🎵 Voice note";
              mediaId   = msg.audio?.id;
              mimeType  = msg.audio?.mime_type;
              mediaType = "audio";
            } else if (msg.type === "video") {
              text = "🎞️ Video";
              mediaId   = msg.video?.id;
              mimeType  = msg.video?.mime_type;
              mediaType = "video";
            } else if (msg.type === "document") {
              fileName  = msg.document?.filename || "Document";
              text      = `📄 ${fileName}`;
              mediaId   = msg.document?.id;
              mimeType  = msg.document?.mime_type;
              mediaType = "document";
            } else if (msg.type === "sticker") {
              text = "🪄 Sticker";
              mediaId   = msg.sticker?.id;
              mediaType = "sticker";
            } else if (msg.type === "location") {
              const loc = msg.location;
              text = `📍 Location: ${loc?.name || ""} (${loc?.latitude}, ${loc?.longitude})`;
            } else if (msg.type === "contacts") {
              const contacts = msg.contacts || [];
              const names = contacts.map(c => c?.name?.formatted_name || "Unknown").join(", ");
              const phones = contacts.flatMap(c => (c?.phones||[]).map(p=>p.wa_id||p.phone)).filter(Boolean);
              text = `👤 Contact: ${names}`;
              // Store full contact data for rich display
              const msgObj2 = {
                id: msg.id, direction: "incoming",
                text, timestamp: new Date(parseInt(msg.timestamp)*1000),
                status: "received", contactData: contacts
              };
              await pushMessage(from, name, msgObj2);
              console.log(`📩 ${name} (${from}): ${text}`);
              continue;
            } else if (msg.type === "unsupported") {
              text = "⚠️ Unsupported message type";
            } else {
              text = `[${msg.type}]`;
            }

            const timestamp = new Date(parseInt(msg.timestamp) * 1000);
            const msgObj = { id: msg.id, direction: "incoming", text, timestamp, status: "received" };
            if (mediaId)   msgObj.mediaId   = mediaId;
            if (mediaType) msgObj.mediaType = mediaType;
            if (mimeType)  msgObj.mimeType  = mimeType;
            if (fileName)  msgObj.fileName  = fileName;

            await pushMessage(from, name, msgObj);
            console.log(`📩 ${name} (${from}): ${text}`);

            // Proactively cache media files so they don't expire
            if (mediaId) {
              setImmediate(async () => {
                try {
                  const cached = await getCachedMedia(mediaId);
                  if (!cached) {
                    const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
                      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
                    });
                    const metaData = await metaRes.json();
                    if (metaData.url) {
                      const fileRes = await fetch(metaData.url, {
                        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
                      });
                      const buf = Buffer.from(await fileRes.arrayBuffer());
                      const cacheObj = { data: buf.toString("base64"), type: mimeType || "application/octet-stream" };
                      await setCachedMedia(mediaId, JSON.stringify(cacheObj));
                      console.log(`💾 Cached media ${mediaId}`);
                    }
                  }
                } catch(e) { console.log(`Cache failed for ${mediaId}:`, e.message); }
              });
            }

            // Fire push notification
            await sendPushToAll(`New message from ${name}`, text.substring(0, 100), from);
          }
        }

        // ── Message status updates (read receipts) ──
        if (value.statuses) {
          for (const s of value.statuses) {
            console.log(`📬 ${s.id} → ${s.status}`);
            await updateMessageStatus(s.id, s.status);
          }
        }
      }
    }
  }
  res.sendStatus(200);
});

// ─── MEDIA PROXY — cached in Redis to survive Meta URL expiry ───
app.get("/api/media/:mediaId", async (req, res) => {
  const token = req.query.token ||
    (req.headers["authorization"] || "").replace("Bearer ", "").trim();
  const session = sessions[token];
  if (!session || Date.now() - session.createdAt > 12 * 60 * 60 * 1000) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const mediaId = req.params.mediaId;

  try {
    // Try Redis cache first
    let base64Data = await getCachedMedia(mediaId);
    let contentType = "application/octet-stream";

    if (!base64Data) {
      // Fetch from Meta
      const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
      });
      const metaData = await metaRes.json();
      if (!metaData.url) return res.status(404).json({ error: "Media not found" });

      contentType = metaData.mime_type || "application/octet-stream";
      const fileRes = await fetch(metaData.url, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
      });
      const buffer = Buffer.from(await fileRes.arrayBuffer());

      // Cache as JSON with type info
      const cacheObj = { data: buffer.toString("base64"), type: contentType };
      await setCachedMedia(mediaId, JSON.stringify(cacheObj));
      base64Data = JSON.stringify(cacheObj);
    }

    // Parse cached data
    let buffer, type;
    try {
      const parsed = JSON.parse(base64Data);
      buffer = Buffer.from(parsed.data, "base64");
      type   = parsed.type || contentType;
    } catch {
      buffer = Buffer.from(base64Data, "base64");
      type   = contentType;
    }

    if (req.query.filename) {
      res.setHeader("Content-Disposition", `attachment; filename="${req.query.filename}"`);
    }

    // Range request support for audio/video seeking
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const parts  = rangeHeader.replace(/bytes=/, "").split("-");
      const start  = parseInt(parts[0], 10);
      const end    = parts[1] ? parseInt(parts[1], 10) : buffer.length - 1;
      const chunk  = end - start + 1;
      res.writeHead(206, {
        "Content-Range":  `bytes ${start}-${end}/${buffer.length}`,
        "Accept-Ranges":  "bytes",
        "Content-Length": chunk,
        "Content-Type":   type,
      });
      return res.end(buffer.slice(start, end + 1));
    }

    res.setHeader("Content-Type", type);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Accept-Ranges", "bytes");
    res.send(buffer);
  } catch (err) {
    console.error("Media proxy error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET ALL CONVERSATIONS ───
app.get("/api/conversations", requireAuth, async (req, res) => {
  const all = await getAllConversations();
  const list = all.map(c => ({
    phone: c.phone, name: c.name, tags: c.tags || [], note: c.note || "",
    lastMessage: c.messages?.[c.messages.length - 1] || null,
    unread: (c.messages || []).filter(m => m.direction === "incoming" && !m.read).length,
  }));
  list.sort((a, b) => new Date(b.lastMessage?.timestamp || 0) - new Date(a.lastMessage?.timestamp || 0));
  res.json(list);
});

// ─── GET SINGLE CONVERSATION ───
app.get("/api/conversations/:phone", requireAuth, async (req, res) => {
  const convo = await getConversation(req.params.phone);
  if (!convo) return res.json({ name: req.params.phone, messages: [], tags: [], note: "" });
  convo.messages.forEach(m => m.read = true);
  await saveConversation(req.params.phone, convo);
  res.json(convo);
});

// ─── UPDATE TAGS & NOTE ───
app.post("/api/conversations/:phone/meta", requireAuth, async (req, res) => {
  const { tags, note } = req.body;
  let convo = await getConversation(req.params.phone);
  if (!convo) return res.status(404).json({ error: "Conversation not found" });
  if (tags !== undefined) convo.tags = tags;
  if (note !== undefined) convo.note = note;
  await saveConversation(req.params.phone, convo);
  res.json({ success: true });
});

// ─── DELETE MULTIPLE MESSAGES ───
app.post("/api/conversations/:phone/messages/bulk-delete", requireAuth, async (req, res) => {
  const { messageIds } = req.body;
  if (!messageIds?.length) return res.status(400).json({ error: "No message IDs provided" });
  const convo = await getConversation(req.params.phone);
  if (!convo) return res.status(404).json({ error: "Not found" });
  convo.messages.forEach(m => {
    if (messageIds.includes(m.id)) {
      m.deleted = true;
      m.text = "🚫 Message deleted";
      delete m.mediaId; delete m.mediaType; delete m.contactData;
    }
  });
  await saveConversation(req.params.phone, convo);
  res.json({ success: true, deleted: messageIds.length });
});

// ─── DELETE WHOLE CHAT ───
app.delete("/api/conversations/:phone", requireAuth, async (req, res) => {
  const p = normalisePhone(req.params.phone) || req.params.phone;
  await redis.del(`convo:${p}`);
  console.log(`🗑️ [${req.user}] Deleted chat: ${p}`);
  res.json({ success: true });
});

// ─── DELETE MESSAGE (hide from UI only) ───
app.delete("/api/conversations/:phone/messages/:msgId", requireAuth, async (req, res) => {
  const convo = await getConversation(req.params.phone);
  if (!convo) return res.status(404).json({ error: "Not found" });
  const msg = convo.messages?.find(m => m.id === req.params.msgId);
  if (msg) {
    msg.deleted = true;
    msg.text = "🚫 Message deleted";
    delete msg.mediaId;
    delete msg.mediaType;
    delete msg.contactData;
    await saveConversation(req.params.phone, convo);
  }
  res.json({ success: true });
});

// ─── EDIT MESSAGE (within 15 minutes of sending) ───
app.patch("/api/conversations/:phone/messages/:msgId", requireAuth, async (req, res) => {
  const { newText } = req.body;
  if (!newText?.trim()) return res.status(400).json({ error: "New text required" });

  const convo = await getConversation(req.params.phone);
  if (!convo) return res.status(404).json({ error: "Not found" });

  const msg = convo.messages?.find(m => m.id === req.params.msgId);
  if (!msg) return res.status(404).json({ error: "Message not found" });

  // Only outgoing messages can be edited
  if (msg.direction !== "outgoing") return res.status(400).json({ error: "Can only edit sent messages" });

  // 15-minute window
  const ageMs = Date.now() - new Date(msg.timestamp).getTime();
  if (ageMs > 15 * 60 * 1000) return res.status(400).json({ error: "Edit window expired (15 minutes)" });

  // Call WhatsApp API to edit
  try {
    const r = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: req.params.phone,
        type: "text",
        text: { body: newText.trim() },
        context: { message_id: msg.id }
      }),
    });
    const data = await r.json();

    // Update locally regardless (Meta may or may not confirm edit)
    msg.originalText = msg.originalText || msg.text;
    msg.text    = newText.trim();
    msg.edited  = true;
    msg.editedAt = new Date();
    await saveConversation(req.params.phone, convo);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── FETCH APPROVED TEMPLATES ───
app.get("/api/templates", requireAuth, async (req, res) => {
  const WABA_ID = process.env.WABA_ID || "";
  if (!WHATSAPP_TOKEN || !WABA_ID) return res.status(500).json({ error: "Not configured" });
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${WABA_ID}/message_templates?status=APPROVED&limit=20&fields=name,language,category,status,components`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const data = await r.json();
    if (data.data) {
      const templates = data.data.map(t => {
        const bodyComp = t.components?.find(c => c.type === "BODY");
        const bodyText = bodyComp?.text || "";
        const varCount = (bodyText.match(/\{\{\d+\}\}/g) || []).length;
        return { name: t.name, language: t.language, category: t.category, body: bodyText, varCount };
      });
      res.json({ templates });
    } else {
      res.status(400).json({ error: data.error?.message || "Failed" });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SEND TEMPLATE ───
app.post("/api/send-template", requireAuth, async (req, res) => {
  const { to, template_name, language_code, components, preview_text } = req.body;
  console.log(`📤 [${req.user}] Template → ${to}: ${template_name}`);
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return res.status(500).json({ error: "Not configured" });
  try {
    const templateObj = { name: template_name, language: { code: language_code || "en" } };
    if (components?.length) templateObj.components = components;
    const r = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: templateObj }),
    });
    const data = await r.json();
    console.log(`📬 Meta:`, JSON.stringify(data));
    if (data.messages) {
      const displayText = preview_text || `[Template: ${template_name}]`;
      await pushMessage(to, to, { id: data.messages[0].id, direction: "outgoing", text: displayText, timestamp: new Date(), read: true, sentBy: req.user, status: "sent" });
      res.json({ success: true });
    } else {
      res.status(400).json({ error: data.error?.message || "Failed" });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SEND MESSAGE ───
app.post("/api/send", requireAuth, async (req, res) => {
  const { to, message, replyTo } = req.body;
  console.log(`📤 [${req.user}] → ${to}: ${message}`);
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return res.status(500).json({ error: "Not configured" });
  try {
    const r = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: message } }),
    });
    const data = await r.json();
    console.log(`📬 Meta:`, JSON.stringify(data));
    if (data.messages) {
      const msgObj = { id: data.messages[0].id, direction: "outgoing", text: message, timestamp: new Date(), read: true, sentBy: req.user, status: "sent" };
      if (replyTo) msgObj.replyTo = replyTo;
      await pushMessage(to, to, msgObj);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: data.error?.message || "Failed" });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── BROADCAST ───
// Store broadcast jobs in memory (progress tracking)
const broadcastJobs = {};

app.post("/api/broadcast", requireAuth, async (req, res) => {
  const { contacts, template_name, language_code, components_template, default_country_code } = req.body;
  // contacts = [{ name, phone, variables: ["val1","val2",...] }]

  if (!contacts?.length)       return res.status(400).json({ error: "No contacts provided" });
  if (!template_name)          return res.status(400).json({ error: "No template selected" });
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return res.status(500).json({ error: "Not configured" });

  const jobId = crypto.randomBytes(8).toString("hex");
  broadcastJobs[jobId] = { total: contacts.length, sent: 0, failed: 0, skipped: 0, errors: [], status: "running", startedAt: new Date() };

  // Respond immediately with job ID — process in background
  res.json({ success: true, jobId, total: contacts.length });

  // Helper: normalise phone number
  function normalisePhone(raw, countryCode) {
    if (!raw) return null;
    let n = String(raw).replace(/[\s\-\(\)\+\.]/g, "");
    if (n.startsWith("00")) n = n.slice(2);
    if (n.startsWith("0"))  n = (countryCode || "92") + n.slice(1);
    if (!/^\d{7,15}$/.test(n)) return null;
    return n;
  }

  // Process in background with 1 second delay between messages (rate limiting)
  const job = broadcastJobs[jobId];
  for (const contact of contacts) {
    if (job.status === "cancelled") break;

    const phone = normalisePhone(contact.phone, default_country_code || "92");
    if (!phone) {
      job.skipped++;
      job.errors.push({ name: contact.name, phone: contact.phone, reason: "Invalid number" });
      continue;
    }

    try {
      // Build template object with per-contact variables
      const templateObj = { name: template_name, language: { code: language_code || "en" } };
      if (contact.variables?.length) {
        templateObj.components = [{
          type: "body",
          parameters: contact.variables.map(v => ({ type: "text", text: v }))
        }];
      }

      const r = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: phone, type: "template", template: templateObj }),
      });
      const data = await r.json();

      if (data.messages) {
        job.sent++;
        // Store in conversation
        const displayText = contact.previewText || `[Template: ${template_name}]`;
        await pushMessage(phone, contact.name || phone, {
          id: data.messages[0].id, direction: "outgoing",
          text: displayText, timestamp: new Date(),
          read: true, sentBy: req.user, status: "sent"
        });
      } else {
        job.failed++;
        job.errors.push({ name: contact.name, phone, reason: data.error?.message || "Send failed" });
      }
    } catch (err) {
      job.failed++;
      job.errors.push({ name: contact.name, phone, reason: err.message });
    }

    // 1 second between messages to respect rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  job.status = "done";
  job.finishedAt = new Date();
  console.log(`📢 Broadcast ${jobId} done: ${job.sent} sent, ${job.failed} failed, ${job.skipped} skipped`);
});

// ─── BROADCAST STATUS ───
app.get("/api/broadcast/:jobId", requireAuth, (req, res) => {
  const job = broadcastJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// ─── CANCEL BROADCAST ───
app.delete("/api/broadcast/:jobId", requireAuth, (req, res) => {
  const job = broadcastJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  job.status = "cancelled";
  res.json({ success: true });
});

// ─── START ───
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 TRH WhatsApp server on port ${PORT}`);
  console.log(`👥 Users: ${Object.keys(parseUsers()).join(", ")}`);
});
