// whatsappOrderBot.js
const fetch = require("node-fetch");

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
let _db = null;
function setDb(db) { _db = db; }
const tokenCache = {}; // phoneNumberId -> { token, at }

// Restaurant ka apna token (embedded signup se mila), na mile to purana META_ACCESS_TOKEN
async function getToken(phoneNumberId) {
  const c = tokenCache[phoneNumberId];
  if (c && Date.now() - c.at < 5 * 60 * 1000) return c.token;

  let token = ACCESS_TOKEN;
  try {
    if (_db) {
      const rid = (await _db.ref(`phoneNumberIdToRestaurant/${phoneNumberId}`).once("value")).val();
      if (rid) {
        const t = (await _db.ref(`whatsappSecrets/${rid}/businessToken`).once("value")).val();
        if (t) token = t;
      }
    }
  } catch (e) {
    console.error("Token lookup failed:", e.message);
  }
  tokenCache[phoneNumberId] = { token, at: Date.now() };
  return token;
}

async function sendWhatsAppMessage(phoneNumberId, payload) {
  const token = await getToken(phoneNumberId);
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    }
  );
  const data = await res.json();
  if (data.error) console.error("WhatsApp send error:", data.error.message, "|", JSON.stringify(data.error.error_data || {}), "| code:", data.error.code);
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
     footer: { text: "Select items and add them to your cart" },
      action: {
        catalog_id: catalogId,
        sections, // [{ title: "Starters", product_items: [{ product_retailer_id: "restId_dishId" }] }]
      },
    },
  });
}
// rows: [{ id, title, description }]  (WhatsApp limit: total 10 rows)
function sendList(phoneNumberId, to, headerText, bodyText, buttonText, rows) {
  return sendWhatsAppMessage(phoneNumberId, {
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: headerText.slice(0, 60) },
      body: { text: bodyText },
      footer: { text: "Tap the button below to choose" },
      action: {
        button: buttonText.slice(0, 20),
        sections: [{ title: "Menu Categories", rows }],
      },
    },
  });
}
// WhatsApp ka native "View catalog" message (collections ke saath catalog khulta hai)
function sendCatalogMessage(phoneNumberId, to, bodyText, thumbnailRetailerId) {
  const action = { name: "catalog_message" };
  if (thumbnailRetailerId) action.parameters = { thumbnail_product_retailer_id: thumbnailRetailerId };
  return sendWhatsAppMessage(phoneNumberId, {
    to,
    type: "interactive",
    interactive: {
      type: "catalog_message",
      body: { text: bodyText },
      footer: { text: "Browse, add to cart and place your order" },
      action,
    },
  });
}
// ★ NEW — WhatsApp Flow open karne wala interactive message
function sendFlowMessage(phoneNumberId, to, flowToken, headerText, bodyText, screen, screenData) {
  return sendWhatsAppMessage(phoneNumberId, {
    to,
    type: "interactive",
    interactive: {
      type: "flow",
      header: { type: "text", text: headerText },
      body: { text: bodyText },
      footer: { text: "Tap the button below" },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: flowToken,
          flow_id: process.env.WHATSAPP_FLOW_ID,
         flow_cta: "Customize Order",
          flow_action: "navigate",
          flow_action_payload: { screen, data: screenData },
        },
      },
    },
  });
}

module.exports = { sendText, sendButtons, sendImage, sendWhatsAppMessage, sendProductList, sendFlowMessage, sendList, sendCatalogMessage, setDb };
