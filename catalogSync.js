// catalogSync.js
const fetch = require("node-fetch");

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const CATALOG_ID = process.env.META_CATALOG_ID;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

async function upsertCatalogItem(restaurantId, dishId, dish) {
  if (!CATALOG_ID || !ACCESS_TOKEN) {
    console.log("Meta catalog config missing, skipping sync");
    return;
  }

  const retailerId = `${restaurantId}_${dishId}`;

  const body = {
    access_token: ACCESS_TOKEN,
    item_type: "PRODUCT_ITEM",
    requests: [
      {
        method: "UPDATE",
        data: {
          id: retailerId,
          availability: dish.inStock !== false && dish.remainingQuantity !== 0 ? "in stock" : "out of stock",
          condition: "new",
          description: dish.description || dish.name,
          image_url: dish.imageUrl || "https://via.placeholder.com/400",
          name: dish.name,
          price: `${Math.round((Number(dish.price) || 0) * 100)} INR`,
          currency: "INR",
          brand: "Khaatogo",
          category: dish.category || "Food",
          url: `https://khaatogo.com/menu/${restaurantId}?item=${dishId}`,
        },
      },
    ],
  };

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${CATALOG_ID}/items_batch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  const data = await res.json();
  if (data.error) {
    console.error(`Catalog sync FAILED for ${retailerId}:`, data.error.message);
    return data;
  }

  console.log(`Catalog sync ACCEPTED for ${retailerId}, handle: ${data.handles?.[0]}`);

  if (data.handles?.[0]) {
    setTimeout(() => checkBatchStatus(data.handles[0], retailerId), 5000);
  }

  return data;
}

async function checkBatchStatus(handle, retailerId) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${CATALOG_ID}/check_batch_request_status?handle=${handle}&access_token=${ACCESS_TOKEN}`
    );
    const data = await res.json();
    console.log(`Batch status for ${retailerId}:`, JSON.stringify(data));
  } catch (e) {
    console.error(`Batch status check failed for ${retailerId}:`, e.message);
  }
}

async function deleteCatalogItem(restaurantId, dishId) {
  if (!CATALOG_ID || !ACCESS_TOKEN) return;
  const retailerId = `${restaurantId}_${dishId}`;

  const body = {
    access_token: ACCESS_TOKEN,
    item_type: "PRODUCT_ITEM",
    requests: [
      {
        method: "DELETE",
        data: { id: retailerId },
      },
    ],
  };

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${CATALOG_ID}/items_batch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json();
  if (data.error) console.error(`Catalog delete FAILED for ${retailerId}:`, data.error.message);
  else console.log(`Catalog delete OK for ${retailerId}`);
}

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