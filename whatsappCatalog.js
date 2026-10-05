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
async function createProductSetsByCategory(catalogId, categories) {
  const results = [];
  for (const category of categories) {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${catalogId}/product_sets`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: ACCESS_TOKEN,
          name: category,
          filter: JSON.stringify({ category: { i_contains: category } }),
        }),
      }
    );
    const data = await res.json();
    if (data.error) console.error(`Product set failed for ${category}:`, data.error.message);
    else results.push({ category, productSetId: data.id });
  }
  return results;
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
// ── App ko WABA se subscribe karo — bina iske messages webhook kabhi nahi aayega ──
async function subscribeAppToWaba(wabaId) {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/subscribed_apps`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: ACCESS_TOKEN }),
    }
  );
  const data = await res.json();
  if (data.error) {
    console.error("Subscribe app to WABA failed:", data.error.message);
  } else {
    console.log(`✅ App subscribed to WABA ${wabaId}`);
  }
  return data;
}
// Har category ke liye ek collection (product set) banao. Jo pehle se hai use chhod do.
async function syncCategoryCollections(catalogId, names) {
  const existing = new Set();
  let url = `https://graph.facebook.com/${GRAPH_VERSION}/${catalogId}/product_sets?fields=name&limit=100&access_token=${ACCESS_TOKEN}`;
  while (url) {
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    (d.data || []).forEach((s) => existing.add(s.name));
    url = d.paging?.next || null;
  }
  const created = [], skipped = [], failed = [];
  for (const name of names) {
    if (existing.has(name)) { skipped.push(name); continue; }

    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${catalogId}/product_sets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: ACCESS_TOKEN,
        name,
        filter: { custom_label_0: { eq: name } },   // ★ object, string nahi
      }),
    });
    const data = await res.json();

    if (data.error) {
      console.error(`Collection failed for ${name}:`, JSON.stringify(data.error));
      failed.push({
        name,
        error: data.error.error_user_msg || data.error.message,
        subcode: data.error.error_subcode,
        fbtrace: data.error.fbtrace_id,
      });
    } else {
      created.push({ name, productSetId: data.id });
    }
  }
  return { created, skipped, failed };

}

module.exports = { attachCatalogToWaba, enableCommerceSettings, subscribeAppToWaba, createProductSetsByCategory, syncCategoryCollections };
