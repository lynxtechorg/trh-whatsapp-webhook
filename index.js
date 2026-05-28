const express = require("express");
const crypto  = require("crypto");
const path    = require("path");
const { MongoClient } = require("mongodb");
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || "colptwebhook";
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN  || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const MONGODB_URI     = process.env.MONGODB_URI     || "";

// ─── MONGODB SETUP ───
let db = null;

async function connectDB() {
  if (!MONGODB_URI) {
    console.log("⚠️  No MONGODB_URI — using in-memory store (conversations won't persist)");
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db("trh_whatsapp");
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
  }
}

// ─── CONVERSATION HELPERS (DB or in-memory fallback) ───
let memStore = {}; // fallback if no DB

async function getConversation(phone) {
  if (db) {
    return await db.collection("conversations").findOne({ phone });
  }
  return memStore[phone] || null;
}

async function saveConversation(phone, data) {
  if (db) {
    await db.collection("conversations").updateOne(
      { phone },
      { $set: { phone, name: data.name, messages: data.messages, updatedAt: new Date() } },
      { upsert: true }
    );
  } else {
    memStore[phone] = data;
  }
}

async function getAllConversations() {
  if (db) {
    return await db.collection("conversations")
      .find({})
      .sort({ updatedAt: -1 })
      .toArray();
  }
  return Object.entries(memStore).map(([phone, data]) => ({ phone, ...data }));
}

async function pushMessage(phone, name, message) {
  let convo = await getConversation(phone);
  if (!convo) convo = { phone, name, messages: [] };
  convo.name = name;
  convo.messages.push(message);
  await saveConversation(phone, convo);
}

// ─── PARSE USERS  e.g. USERS=admin:pass1,staff:pass2 ───
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
  const auth  = req.headers["authorization"] || "";
  const token = auth.replace("Bearer ", "").trim();
  if (!token) return null;
  const session = sessions[token];
  if (!session) return null;
  if (Date.now() - session.createdAt > 12 * 60 * 60 * 1000) {
    delete sessions[token];
    return null;
  }
  return session;
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  req.user = session.username;
  next();
}

// ─── ROUTES: public pages ───
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/trh-logo.png", (req, res) => res.sendFile(path.join(__dirname, "public", "trh-logo.png")));

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
  if (token && sessions[token]) {
    console.log(`👋 Logout: ${sessions[token].username}`);
    delete sessions[token];
  }
  res.json({ success: true });
});

// ─── WEBHOOK VERIFICATION (public) ───
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── RECEIVE MESSAGES (public — called by Meta) ───
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object === "whatsapp_business_account") {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (value.messages) {
          for (const msg of value.messages) {
            const from = msg.from;
            const name = value.contacts?.[0]?.profile?.name || from;
            let text;
            if      (msg.type === "text")        text = msg.text.body;
            else if (msg.type === "button")      text = msg.button?.text || "[button]";
            else if (msg.type === "interactive") {
              const ir = msg.interactive;
              if      (ir?.type === "button_reply") text = ir.button_reply?.title || "[button reply]";
              else if (ir?.type === "list_reply")   text = ir.list_reply?.title   || "[list reply]";
              else text = "[interactive]";
            }
            else if (msg.type === "image")    text = "📷 Image";
            else if (msg.type === "audio")    text = "🎵 Voice message";
            else if (msg.type === "document") text = "📄 Document";
            else if (msg.type === "location") text = "📍 Location";
            else text = `[${msg.type}]`;

            const timestamp = new Date(parseInt(msg.timestamp) * 1000);
            await pushMessage(from, name, { id: msg.id, direction: "incoming", text, timestamp });
            console.log(`📩 ${name} (${from}): ${text}`);
          }
        }
        if (value.statuses) {
          value.statuses.forEach(s => console.log(`📬 ${s.id} → ${s.status}`));
        }
      }
    }
  }
  res.sendStatus(200);
});

// ─── GET ALL CONVERSATIONS ───
app.get("/api/conversations", requireAuth, async (req, res) => {
  const all = await getAllConversations();
  const list = all.map(c => ({
    phone: c.phone,
    name: c.name,
    lastMessage: c.messages?.[c.messages.length - 1] || null,
    unread: (c.messages || []).filter(m => m.direction === "incoming" && !m.read).length,
  }));
  list.sort((a, b) => new Date(b.lastMessage?.timestamp || 0) - new Date(a.lastMessage?.timestamp || 0));
  res.json(list);
});

// ─── GET SINGLE CONVERSATION ───
app.get("/api/conversations/:phone", requireAuth, async (req, res) => {
  const convo = await getConversation(req.params.phone);
  if (!convo) return res.json({ name: req.params.phone, messages: [] });
  // Mark as read
  convo.messages.forEach(m => m.read = true);
  await saveConversation(req.params.phone, convo);
  res.json(convo);
});

// ─── FETCH APPROVED TEMPLATES ───
app.get("/api/templates", requireAuth, async (req, res) => {
  const WABA_ID = process.env.WABA_ID || "";
  if (!WHATSAPP_TOKEN || !WABA_ID)
    return res.status(500).json({ error: "WHATSAPP_TOKEN or WABA_ID not configured" });
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
      res.status(400).json({ error: data.error?.message || "Failed to fetch templates" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SEND TEMPLATE ───
app.post("/api/send-template", requireAuth, async (req, res) => {
  const { to, template_name, language_code, components, preview_text } = req.body;
  console.log(`📤 [${req.user}] Template → ${to}: ${template_name}`);
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID)
    return res.status(500).json({ error: "Not configured" });
  try {
    const templateObj = { name: template_name, language: { code: language_code || "en" } };
    if (components && components.length > 0) templateObj.components = components;
    const r = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: templateObj }),
    });
    const data = await r.json();
    console.log(`📬 Meta:`, JSON.stringify(data));
    if (data.messages) {
      // Store actual message text (with variables filled in) instead of template name
      const displayText = preview_text || `[Template: ${template_name}]`;
      await pushMessage(to, to, {
        id: data.messages[0].id, direction: "outgoing",
        text: displayText, timestamp: new Date(), read: true, sentBy: req.user
      });
      res.json({ success: true });
    } else {
      res.status(400).json({ error: data.error?.message || "Template send failed" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SEND MESSAGE ───
app.post("/api/send", requireAuth, async (req, res) => {
  const { to, message } = req.body;
  console.log(`📤 [${req.user}] → ${to}: ${message}`);
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID)
    return res.status(500).json({ error: "Not configured" });
  try {
    const r = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: message } }),
    });
    const data = await r.json();
    console.log(`📬 Meta:`, JSON.stringify(data));
    if (data.messages) {
      await pushMessage(to, to, {
        id: data.messages[0].id, direction: "outgoing",
        text: message, timestamp: new Date(), read: true, sentBy: req.user
      });
      res.json({ success: true });
    } else {
      res.status(400).json({ error: data.error?.message || "Send failed" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ───
connectDB().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 TRH WhatsApp server on port ${PORT}`);
    console.log(`👥 Users: ${Object.keys(parseUsers()).join(", ")}`);
  });
});
