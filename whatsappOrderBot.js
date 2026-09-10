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
function sendImage(phoneNumberId, to, imageUrl, caption) {
  return sendWhatsAppMessage(phoneNumberId, {
    to,
    type: "image",
    image: { link: imageUrl, caption },
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
// whatsappOrderBot.js mein ADD karo (sendButtons ke baad)

// ★ NEW — poora menu category-wise, WhatsApp product list ke roop mein bhejta hai
function sendProductList(phoneNumberId, to, catalogId, headerText, bodyText, sections) {
  return sendWhatsAppMessage(phoneNumberId, {
    to,
    type: "interactive",
    interactive: {
      type: "product_list",
      header: { type: "text", text: headerText },
      body: { text: bodyText },
      footer: { text: "Items select karke cart mein add karo" },
      action: {
        catalog_id: catalogId,
        sections, // [{ title: "Starters", product_items: [{ product_retailer_id: "restId_dishId" }] }]
      },
    },
  });
}

module.exports = { sendText, sendButtons, sendImage, sendWhatsAppMessage, sendProductList }; // ★ sendProductList add