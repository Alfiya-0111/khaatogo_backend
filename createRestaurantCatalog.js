// createRestaurantCatalog.js
const fetch = require("node-fetch");

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const BUSINESS_ID = process.env.META_BUSINESS_ID;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const FEED_BASE_URL = "https://khaatogobackend-production.up.railway.app";
async function createRestaurantCatalog(restaurantId, restaurantName, partnerBusinessId) {
  if (!partnerBusinessId || !ACCESS_TOKEN) {
    throw new Error("Restaurant ka Meta Business ID ya META_ACCESS_TOKEN missing hai");
  }

  // ── Step 1: naya catalog RESTAURANT ke apne Business Manager ke andar banao ──
  const catalogRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${partnerBusinessId}/owned_product_catalogs`,
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
    console.error("FULL Meta error:", JSON.stringify(catalogData.error, null, 2)); // ★ full detail
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

  return { catalogId, feedId: feedData.id };
}

module.exports = { createRestaurantCatalog };