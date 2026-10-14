// catalogSync.js
const { buildCatalogEntries, MAX_VARIANT_SLOTS } = require("./catalogVariants");
const fetch = require("node-fetch");

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

async function getCatalogId(db, restaurantId) {
  const snap = await db.ref(`restaurants/${restaurantId}/metaCatalog/catalogId`).once("value");
  return snap.val();
}

async function upsertCatalogItem(db, restaurantId, dishId, dish, restaurantGeo) {
  const catalogId = await getCatalogId(db, restaurantId);
  if (!catalogId || !ACCESS_TOKEN) {
    console.log(`Catalog ID missing for ${restaurantId}, skipping sync`);
    return;
  }

  const baseId = `${restaurantId}_${dishId}`;
  const available =
    dish.inStock !== false && dish.remainingQuantity !== 0 ? "in stock" : "out of stock";
  const entries = buildCatalogEntries(dish);
  const variantCount = entries.length - 1;

  const requests = entries
    .filter((e) => e.price > 0)
    .map((e) => ({
      method: "UPDATE",
      data: {
        id: `${baseId}${e.idSuffix}`,
        availability: available,
        condition: "new",
        description: dish.description || dish.name,
        image_url: dish.imageUrl || "https://via.placeholder.com/400",
        name: e.name,
        price: `${e.price.toFixed(2)} INR`,
        currency: "INR",
        brand: "Khaatogo",
        category: dish.category || "Food",
        url: `https://khaatogo.com/menu/${restaurantId}?item=${dishId}`,
        availability_circle_origin: { latitude: restaurantGeo?.lat, longitude: restaurantGeo?.lng },
        availability_circle_radius: 5,
        availability_circle_radius_unit: "km",
      },
    }));

  // Jo variant ab nahi rahe unhe catalog se hata do
  for (let i = variantCount; i < MAX_VARIANT_SLOTS; i++) {
    requests.push({ method: "DELETE", data: { id: `${baseId}__v${i}` } });
  }

  const body = { access_token: ACCESS_TOKEN, item_type: "PRODUCT_ITEM", requests };

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${catalogId}/items_batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) console.error(`Catalog sync FAILED for ${baseId}:`, data.error.message);
  else console.log(`Catalog sync ACCEPTED for ${baseId}`);
  return data;
}

async function deleteCatalogItem(db, restaurantId, dishId) {
  const catalogId = await getCatalogId(db, restaurantId);
  if (!catalogId || !ACCESS_TOKEN) return;
  const retailerId = `${restaurantId}_${dishId}`;

const requests = [{ method: "DELETE", data: { id: retailerId } }];
for (let i = 0; i < MAX_VARIANT_SLOTS; i++) {
  requests.push({ method: "DELETE", data: { id: `${retailerId}__v${i}` } });
}
const body = { access_token: ACCESS_TOKEN, item_type: "PRODUCT_ITEM", requests };
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${catalogId}/items_batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) console.error(`Catalog delete FAILED for ${retailerId}:`, data.error.message);
}

function setupCatalogSync(db) {
  const menuRootRef = db.ref("restaurants");

  menuRootRef.on("child_added", (restaurantSnap) => {
    const restaurantId = restaurantSnap.key;
    const menuRef = db.ref(`restaurants/${restaurantId}/menu`);
    let initialLoadDone = false;

    const getRestaurantGeo = async () => {
      const geoSnap = await db.ref(`restaurants/${restaurantId}/attendanceGeofence`).once("value");
      return geoSnap.val() || {};
    };

    menuRef.once("value", () => { initialLoadDone = true; });

    menuRef.on("child_added", async (snap) => {
      if (!initialLoadDone) return;
      const geo = await getRestaurantGeo();
      upsertCatalogItem(db, restaurantId, snap.key, snap.val(), geo); // ★ db pass karo
    });

    menuRef.on("child_changed", async (snap) => {
      const geo = await getRestaurantGeo();
      upsertCatalogItem(db, restaurantId, snap.key, snap.val(), geo); // ★ db pass karo
    });

    menuRef.on("child_removed", (snap) => deleteCatalogItem(db, restaurantId, snap.key)); // ★ db pass karo
  });

  console.log("✅ Meta catalog sync listener started");
}

module.exports = { setupCatalogSync, upsertCatalogItem };