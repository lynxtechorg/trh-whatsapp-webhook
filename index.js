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
async function getConversation(phone) {
  return (await redis.get(`convo:${phone}`)) || null;
}
async function saveConversation(phone, data) {
  await redis.set(`convo:${phone}`, data);
}
async function getAllConversations() {
  const keys = await redis.keys("convo:*");
  if (!keys.length) return [];
  const convos = await Promise.all(keys.map(k => redis.get(k)));
  return convos.filter(Boolean);
}
async function pushMessage(phone, name, message) {
  let convo = await getConversation(phone);
  if (!convo) convo = { phone, name, messages: [], tags: [], note: "" };
  convo.name = name;
  convo.messages.push(message);
  await saveConversation(phone, convo);
  return convo;
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

        // ── Incoming messages ──
        if (value.messages) {
          for (const msg of value.messages) {
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

            // Fire push notification to all logged-in staff
            await sendPushToAll(
              `New message from ${name}`,
              text.substring(0, 100),
              from
            );
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

// ─── MEDIA PROXY — supports range requests for proper audio/video streaming ───
app.get("/api/media/:mediaId", async (req, res) => {
  const token = req.query.token ||
    (req.headers["authorization"] || "").replace("Bearer ", "").trim();
  const session = sessions[token];
  if (!session || Date.now() - session.createdAt > 12 * 60 * 60 * 1000) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Step 1: get download URL from Meta
    const metaRes = await fetch(`https://graph.facebook.com/v19.0/${req.params.mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    const metaData = await metaRes.json();
    if (!metaData.url) return res.status(404).json({ error: "Media not found" });

    // Step 2: fetch full file
    const fileRes = await fetch(metaData.url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });

    const buffer = Buffer.from(await fileRes.arrayBuffer());
    const contentType = metaData.mime_type || "application/octet-stream";
    const totalSize = buffer.length;

    if (req.query.filename) {
      res.setHeader("Content-Disposition", `attachment; filename="${req.query.filename}"`);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", totalSize);
      return res.send(buffer);
    }

    // Handle range requests (critical for audio/video seeking)
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const parts  = rangeHeader.replace(/bytes=/, "").split("-");
      const start  = parseInt(parts[0], 10);
      const end    = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
      const chunk  = end - start + 1;

      res.writeHead(206, {
        "Content-Range":  `bytes ${start}-${end}/${totalSize}`,
        "Accept-Ranges":  "bytes",
        "Content-Length": chunk,
        "Content-Type":   contentType,
      });
      return res.end(buffer.slice(start, end + 1));
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", totalSize);
    res.setHeader("Accept-Ranges", "bytes");
    res.send(buffer);
  } catch (err) {
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

// ─── START ───
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 TRH WhatsApp server on port ${PORT}`);
  console.log(`👥 Users: ${Object.keys(parseUsers()).join(", ")}`);
});
