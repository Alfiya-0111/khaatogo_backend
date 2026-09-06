// whatsappOrderBot.js
const fetch = require("node-fetch");

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

async function sendWhatsAppMessage(phoneNumberId, payload) {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    }
  );
  const data = await res.json();
  if (data.error) console.error("WhatsApp send error:", data.error.message);
  return data;
}

function sendText(phoneNumberId, to, text) {
  return sendWhatsAppMessage(phoneNumberId, {
    to,
    type: "text",
    text: { body: text },
  });
}

// buttons: [{ id, title }] — max 3 buttons allowed by WhatsApp
function sendButtons(phoneNumberId, to, bodyText, buttons) {
  return sendWhatsAppMessage(phoneNumberId, {
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

module.exports = { sendText, sendButtons, sendWhatsAppMessage };