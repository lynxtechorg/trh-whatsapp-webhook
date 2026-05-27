const express = require("express");
const app = express();

app.use(express.json());
app.use(express.static("public"));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "colptwebhook";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";

// In-memory message store
let conversations = {};

// ─── WEBHOOK VERIFICATION (Meta calls this when you save the webhook) ───
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

// ─── RECEIVE INCOMING MESSAGES ───
app.post("/webhook", (req, res) => {
  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    body.entry?.forEach((entry) => {
      entry.changes?.forEach((change) => {
        const value = change.value;

        // Incoming message
        if (value.messages) {
          value.messages.forEach((msg) => {
            const from = msg.from;
            const name = value.contacts?.[0]?.profile?.name || from;
            let text;
            if (msg.type === "text") {
              text = msg.text.body;
            } else if (msg.type === "button") {
              // Quick reply button tap — show the actual button text
              text = msg.button?.text || "[button]";
            } else if (msg.type === "interactive") {
              // List reply or button reply
              const ir = msg.interactive;
              if (ir?.type === "button_reply") text = ir.button_reply?.title || "[button reply]";
              else if (ir?.type === "list_reply") text = ir.list_reply?.title || "[list reply]";
              else text = "[interactive message]";
            } else if (msg.type === "image") {
              text = "📷 Image";
            } else if (msg.type === "audio") {
              text = "🎵 Voice message";
            } else if (msg.type === "document") {
              text = "📄 Document";
            } else if (msg.type === "location") {
              text = "📍 Location";
            } else {
              text = `[${msg.type}]`;
            }
            const timestamp = new Date(parseInt(msg.timestamp) * 1000);

            if (!conversations[from]) {
              conversations[from] = { name, messages: [] };
            }
            conversations[from].name = name;
            conversations[from].messages.push({
              id: msg.id,
              direction: "incoming",
              text,
              timestamp,
            });

            console.log(`📩 Message from ${name} (${from}): ${text}`);
          });
        }

        // Message status updates
        if (value.statuses) {
          value.statuses.forEach((status) => {
            console.log(`📬 Message ${status.id} status: ${status.status}`);
          });
        }
      });
    });
  }

  res.sendStatus(200);
});

// ─── GET ALL CONVERSATIONS (for the inbox UI) ───
app.get("/api/conversations", (req, res) => {
  const list = Object.entries(conversations).map(([phone, data]) => ({
    phone,
    name: data.name,
    lastMessage: data.messages[data.messages.length - 1] || null,
    unread: data.messages.filter(
      (m) => m.direction === "incoming" && !m.read
    ).length,
  }));
  list.sort(
    (a, b) =>
      new Date(b.lastMessage?.timestamp || 0) -
      new Date(a.lastMessage?.timestamp || 0)
  );
  res.json(list);
});

// ─── GET MESSAGES FOR A SPECIFIC CONVERSATION ───
app.get("/api/conversations/:phone", (req, res) => {
  const phone = req.params.phone;
  const convo = conversations[phone];
  if (!convo) return res.json({ name: phone, messages: [] });

  // Mark as read
  convo.messages.forEach((m) => (m.read = true));
  res.json(convo);
});

// ─── FETCH APPROVED TEMPLATES FROM META ───
app.get("/api/templates", async (req, res) => {
  const WABA_ID = process.env.WABA_ID || "";

  if (!WHATSAPP_TOKEN || !WABA_ID) {
    return res.status(500).json({ error: "WHATSAPP_TOKEN or WABA_ID not configured" });
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${WABA_ID}/message_templates?status=APPROVED&limit=20&fields=name,language,category,status,components`,
      {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
      }
    );
    const data = await response.json();

    if (data.data) {
      const templates = data.data.map(t => {
        // Extract body text and count variables like {{1}}
        const bodyComp = t.components?.find(c => c.type === "BODY");
        const bodyText = bodyComp?.text || "";
        const varMatches = bodyText.match(/\{\{\d+\}\}/g) || [];
        const varCount = varMatches.length;
        return {
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          body: bodyText,
          varCount,
        };
      });
      res.json({ templates });
    } else {
      res.status(400).json({ error: data.error?.message || "Failed to fetch templates" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SEND A TEMPLATE MESSAGE (to initiate conversation) ───
app.post("/api/send-template", async (req, res) => {
  const { to, template_name, language_code, components } = req.body;

  console.log(`📤 Template send request → to: ${to}, template: ${template_name}`);

  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    return res.status(500).json({ error: "WHATSAPP_TOKEN or PHONE_NUMBER_ID not configured" });
  }

  try {
    const templateObj = {
      name: template_name,
      language: { code: language_code || "en" }
    };

    // Only add components if variables were provided
    if (components && components.length > 0) {
      templateObj.components = components;
    }

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: templateObj
    };

    console.log(`📡 Sending template:`, JSON.stringify(payload));

    const response = await fetch(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    const data = await response.json();
    console.log(`📬 Meta API response:`, JSON.stringify(data));

    if (data.messages) {
      if (!conversations[to]) {
        conversations[to] = { name: to, messages: [] };
      }
      conversations[to].messages.push({
        id: data.messages[0].id,
        direction: "outgoing",
        text: `[Template: ${template_name}]`,
        timestamp: new Date(),
        read: true,
      });
      res.json({ success: true, id: data.messages[0].id });
    } else {
      console.log("❌ Template send failed:", data.error);
      res.status(400).json({ error: data.error?.message || "Template send failed" });
    }
  } catch (err) {
    console.log("❌ Exception during template send:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── SEND A MESSAGE ───
app.post("/api/send", async (req, res) => {
  const { to, message } = req.body;

  console.log(`📤 Send request → to: ${to}, message: ${message}`);
  console.log(`🔑 Token present: ${!!WHATSAPP_TOKEN}, Phone ID: ${PHONE_NUMBER_ID}`);

  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log("❌ Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID");
    return res
      .status(500)
      .json({ error: "WHATSAPP_TOKEN or PHONE_NUMBER_ID not configured" });
  }

  try {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    };

    console.log(`📡 Calling Meta API with Phone Number ID: ${PHONE_NUMBER_ID}`);

    const response = await fetch(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    const data = await response.json();
    console.log(`📬 Meta API response:`, JSON.stringify(data));

    if (data.messages) {
      if (!conversations[to]) {
        conversations[to] = { name: to, messages: [] };
      }
      conversations[to].messages.push({
        id: data.messages[0].id,
        direction: "outgoing",
        text: message,
        timestamp: new Date(),
        read: true,
      });
      res.json({ success: true, id: data.messages[0].id });
    } else {
      console.log("❌ Send failed:", data.error);
      res.status(400).json({ error: data.error?.message || "Send failed" });
    }
  } catch (err) {
    console.log("❌ Exception during send:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp webhook server running on port ${PORT}`);
  console.log(`🔑 Verify token: ${VERIFY_TOKEN}`);
});
