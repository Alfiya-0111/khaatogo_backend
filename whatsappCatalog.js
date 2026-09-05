// whatsappCatalog.js
const fetch = require("node-fetch");

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

// ── Catalog ko WhatsApp Business Account (WABA) se attach karo ──
async function attachCatalogToWaba(wabaId, catalogId) {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: ACCESS_TOKEN,
        catalog_id: catalogId,
      }),
    }
  );
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error.message);
  }
  return data;
}

// ── Business phone number pe cart + catalog visibility enable karo ──
async function enableCommerceSettings(phoneNumberId) {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/whatsapp_commerce_settings`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: ACCESS_TOKEN,
        is_catalog_visible: true,
        is_cart_enabled: true,
      }),
    }
  );
  const data = await res.json();
  if (data.error) {
    console.error("Commerce settings enable failed:", data.error.message);
  }
  return data;
}

module.exports = { attachCatalogToWaba, enableCommerceSettings };