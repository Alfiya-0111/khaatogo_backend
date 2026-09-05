// createRestaurantCatalog.js
const fetch = require("node-fetch");

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const BUSINESS_ID = process.env.META_BUSINESS_ID;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const FEED_BASE_URL = "https://khaatogobackend-production.up.railway.app";

async function createRestaurantCatalog(restaurantId, restaurantName, partnerBusinessId) {
  if (!BUSINESS_ID || !ACCESS_TOKEN) {
    throw new Error("META_BUSINESS_ID ya META_ACCESS_TOKEN missing hai .env mein");
  }

  // ── Step 1: naya catalog banao ──
  const catalogRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${BUSINESS_ID}/owned_product_catalogs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: ACCESS_TOKEN,
        name: `${restaurantName} - Khaatogo`,
        vertical: "commerce",
        additional_vertical_option: "LOCAL_PRODUCTS",
      }),
    }
  );
  const catalogData = await catalogRes.json();
  if (catalogData.error) {
    throw new Error(`Catalog create failed: ${catalogData.error.message}`);
  }
  const catalogId = catalogData.id;
  console.log(`✅ Catalog created for ${restaurantId}: ${catalogId}`);

  // ── Step 2: catalog ke andar product feed (data source) banao ──
  const feedUrl = `${FEED_BASE_URL}/catalog-feed/${restaurantId}.csv`;
  const feedRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${catalogId}/product_feeds`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: ACCESS_TOKEN,
        name: `${restaurantName} feed`,
        schedule: {
          interval: "HOURLY",
          url: feedUrl,
        },
      }),
    }
  );
  const feedData = await feedRes.json();
  if (feedData.error) {
    throw new Error(`Feed create failed: ${feedData.error.message}`);
  }
  console.log(`✅ Feed linked: ${feedData.id}`);

  // ── Step 3: restaurant ke apne Business Manager ke saath share karo ──
  let shareResult = null;
  if (partnerBusinessId) {
    const shareRes = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${catalogId}/agencies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: ACCESS_TOKEN,
          business: partnerBusinessId,
          permitted_tasks: ["ADVERTISE"],
        }),
      }
    );
    shareResult = await shareRes.json();
    if (shareResult.error) {
      console.error(`⚠️ Sharing failed for ${restaurantId}:`, shareResult.error.message);
    } else {
      console.log(`✅ Shared with partner business ${partnerBusinessId}`);
    }
  }

  return { catalogId, feedId: feedData.id, shareResult };
}

module.exports = { createRestaurantCatalog };