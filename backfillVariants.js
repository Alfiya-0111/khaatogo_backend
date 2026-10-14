// backfillVariants.js
const { upsertCatalogItem } = require("./catalogSync");

async function backfillVariants(db) {
  const rests = (await db.ref("restaurants").once("value")).val() || {};
  for (const [rid, r] of Object.entries(rests)) {
    if (!r.metaCatalog?.catalogId || !r.menu) continue;
    for (const [dishId, dish] of Object.entries(r.menu)) {
      if (!Array.isArray(dish.priceVariants) || dish.priceVariants.length === 0) continue;
      await upsertCatalogItem(db, rid, dishId, dish, r.attendanceGeofence || {});
      await new Promise((res) => setTimeout(res, 300));
    }
  }
  console.log("backfill done");
}

module.exports = { backfillVariants };