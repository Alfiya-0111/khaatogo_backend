// catalogSync.js
const fetch = require("node-fetch"); // agar node-fetch nahi hai to: npm install node-fetch@2

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const CATALOG_ID = process.env.META_CATALOG_ID;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

// Ek dish ko Meta Catalog me add/update karta hai
async function upsertCatalogItem(restaurantId, dishId, dish) {
  if (!CATALOG_ID || !ACCESS_TOKEN) {
    console.log("Meta catalog config missing, skipping sync");
    return;
  }

  const retailerId = `${restaurantId}_${dishId}`; // unique ID sab restaurants me

  const item = {
    method: "UPDATE",
    retailer_id: retailerId,
    data: {
      availability: dish.inStock !== false && dish.remainingQuantity !== 0 ? "in stock" : "out of stock",
      condition: "new",
      description: dish.description || dish.name,
      image_url: dish.imageUrl || "https://via.placeholder.com/400",
      name: dish.name,
      price: `${Math.round((Number(dish.price) || 0) * 100)} INR`, // paise me, INR currency
      currency: "INR",
      brand: "Khaatogo",
      category: dish.category || "Food",
      url: `https://khaatogo.com/menu/${restaurantId}?item=${dishId}`, // dummy product-page link, required field
    },
  };

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${CATALOG_ID}/items_batch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: ACCESS_TOKEN,
        requests: [item],
      }),
    }
  );

  const data = await res.json();
  if (data.error) {
    console.error(`Catalog sync FAILED for ${retailerId}:`, data.error.message);
  } else {
    console.log(`Catalog sync OK for ${retailerId}`);
  }
  return data;
}

// Dish delete hone par catalog se bhi hatao
async function deleteCatalogItem(restaurantId, dishId) {
  if (!CATALOG_ID || !ACCESS_TOKEN) return;
  const retailerId = `${restaurantId}_${dishId}`;

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${CATALOG_ID}/items_batch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: ACCESS_TOKEN,
        requests: [{ method: "DELETE", retailer_id: retailerId }],
      }),
    }
  );
  const data = await res.json();
  if (data.error) console.error(`Catalog delete FAILED for ${retailerId}:`, data.error.message);
  else console.log(`Catalog delete OK for ${retailerId}`);
}

// Server start hote hi RTDB listen karo — har restaurant ke menu me koi bhi change
function setupCatalogSync(db) {
  const menuRootRef = db.ref("restaurants");

  menuRootRef.on("child_added", (restaurantSnap) => {
    const restaurantId = restaurantSnap.key;
    const menuRef = db.ref(`restaurants/${restaurantId}/menu`);

    menuRef.on("child_added", (snap) => upsertCatalogItem(restaurantId, snap.key, snap.val()));
    menuRef.on("child_changed", (snap) => upsertCatalogItem(restaurantId, snap.key, snap.val()));
    menuRef.on("child_removed", (snap) => deleteCatalogItem(restaurantId, snap.key));
  });

  console.log("✅ Meta catalog sync listener started");
}

module.exports = { setupCatalogSync, upsertCatalogItem, deleteCatalogItem };