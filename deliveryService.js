// deliveryService.js
// Provider-independent delivery logic. Porter/Rapido ka actual API code providers/ mein hai.
//
// Firebase mein ye data banta hai:
//   orders/{restaurantId}/{orderId}/delivery  → status, provider, providerOrderId, trackingUrl, fare, history, errors
//   deliveryIndex/{provider}/{providerOrderId} → { restaurantId, orderId }  (webhook se order dhoondhne ke liye)
//
// delivery.status values:
//   booking        → booking chal rahi hai (lock)
//   booked         → provider ne order le liya
//   assigned       → driver mil gaya
//   picked_up      → driver ne food utha liya
//   delivered      → delivery complete
//   cancelled      → cancel ho gayi
//   reopened       → driver hata, naya driver dhoondha ja raha hai
//   needs_location → customer ke drop ka lat/lng nahi hai, booking nahi ho saki
//   no_provider    → koi provider ready nahi hai (retry baad mein ho sakta hai)
//   failed         → saare ready providers fail hue

const providers = require("./providers");

const RETRYABLE = ["failed", "needs_location", "no_provider"];
const TERMINAL = ["delivered", "cancelled"];

const num = (v) => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n) ? n : null;
};

// Firebase keys mein . # $ [ ] / allowed nahi hote
const safeKey = (s) => String(s).replace(/[.#$\[\]\/]/g, "_");

function getDropLocation(order) {
  const d = order.deliveryInfo || {};
  const lat = num(d.lat ?? d.location?.lat ?? order.deliveryLocation?.lat);
  const lng = num(d.lng ?? d.location?.lng ?? order.deliveryLocation?.lng);
  if (lat === null || lng === null) return null;
  return { lat, lng };
}

function getPickup(restaurant) {
  const geo = restaurant.attendanceGeofence || {};
  const lat = num(geo.lat);
  const lng = num(geo.lng);
  if (lat === null || lng === null) return null;
  const c = restaurant.contact || {};
  return {
    lat,
    lng,
    address: [c.address, c.city, c.pincode].filter(Boolean).join(", "),
    name: restaurant.name || "Restaurant",
    phone: c.phone || "",
  };
}

function checkEligibility(order, restaurant) {
  if (order.orderType !== "delivery") return { ok: false, reason: "not_delivery_order" };
  if (order.platform) return { ok: false, reason: "platform_order" }; // Swiggy/Zomato
  if (order.paymentStatus !== "paid_online") return { ok: false, reason: "not_paid_online" }; // COD nahi
  if (restaurant.settings?.khaatogoDelivery !== true) return { ok: false, reason: "delivery_disabled" };
  return { ok: true };
}

const short = (s) => String(s || "").slice(0, 300);

/**
 * Order ke liye delivery book karo.
 * - Idempotent: Razorpay webhook retry ho to bhi dobara booking nahi hogi.
 * - force=true sirf failed / needs_location / no_provider state ko dobara try karta hai.
 */
async function bookDelivery(db, restaurantId, orderId, { force = false } = {}) {
  const orderRef = db.ref(`orders/${restaurantId}/${orderId}`);
  const [orderSnap, restSnap] = await Promise.all([
    orderRef.once("value"),
    db.ref(`restaurants/${restaurantId}`).once("value"),
  ]);

  const order = orderSnap.val();
  if (!order) return { status: "skipped", reason: "order_not_found" };
  const restaurant = restSnap.val() || {};

  const elig = checkEligibility(order, restaurant);
  if (!elig.ok) return { status: "skipped", reason: elig.reason };

  // ── Lock: sirf ek hi caller booking shuru kar sakta hai ──
  const deliveryRef = orderRef.child("delivery");
  const tx = await deliveryRef.transaction((cur) => {
    if (cur && !(force && RETRYABLE.includes(cur.status))) return; // abort
    return {
      ...(cur || {}),
      status: "booking",
      startedAt: Date.now(),
      attempts: (cur?.attempts || 0) + 1,
    };
  });
  if (!tx.committed) return { status: "skipped", reason: "already_handled" };

  const finish = async (fields) => {
    await deliveryRef.update({ ...fields, updatedAt: Date.now() });
    return { status: fields.status, ...(fields.error ? { error: fields.error } : {}) };
  };

  const pickup = getPickup(restaurant);
  const drop = getDropLocation(order);
  if (!pickup) {
    return finish({
      status: "needs_location",
      error: "Restaurant ka pickup location (lat/lng) set nahi hai",
    });
  }
  if (!drop) {
    return finish({
      status: "needs_location",
      error: "Customer ke delivery address ka lat/lng nahi mila",
    });
  }

  const candidates = providers.ready();
  if (candidates.length === 0) {
    return finish({ status: "no_provider", error: "Koi delivery provider abhi ready nahi hai" });
  }

  const dropInfo = {
    ...drop,
        address: [order.deliveryInfo?.address || order.address, order.deliveryInfo?.landmark].filter(Boolean).join(", "),
    name: order.customerName || "Customer",
    phone: order.customerPhone || order.customerInfo?.phone || "",
  };

  const errors = [];
  for (const p of candidates) {
    try {
      const res = await p.createOrder({
        requestId: orderId, // provider side par unique reference
        pickup,
        drop: dropInfo,
        order,
      });
      if (!res || !res.providerOrderId) throw new Error("Provider ne order id nahi diya");

      await db.ref(`deliveryIndex/${p.name}/${safeKey(res.providerOrderId)}`).set({ restaurantId, orderId });
      return finish({
        status: "booked",
        provider: p.name,
        providerOrderId: String(res.providerOrderId),
        trackingUrl: res.trackingUrl || null,
        fare: num(res.fare),
        bookedAt: Date.now(),
        error: null,
        errors: null,
      });
    } catch (e) {
      console.error(`Delivery booking failed [${p.name}] order ${orderId}:`, e.message);
      errors.push({ provider: p.name, message: short(e.message) });
    }
  }

  return finish({
    status: "failed",
    error: "Saare delivery providers fail hue",
    errors,
  });
}

/**
 * Provider ke webhook se aaya status apply karo.
 * Terminal status (delivered/cancelled) se peeche nahi jaayega.
 */
async function applyDeliveryStatus(db, providerName, providerOrderId, status, extra = {}) {
  const idxSnap = await db.ref(`deliveryIndex/${providerName}/${safeKey(providerOrderId)}`).once("value");
  const idx = idxSnap.val();
  if (!idx) return { applied: false, reason: "unknown_order" };

  const deliveryRef = db.ref(`orders/${idx.restaurantId}/${idx.orderId}/delivery`);
  const now = Date.now();

  const tx = await deliveryRef.transaction((cur) => {
    if (!cur) return; // abort
    if (TERMINAL.includes(cur.status)) return; // final state badalni nahi
    return { ...cur, status, updatedAt: now, ...extra };
  });
  if (!tx.committed) return { applied: false, reason: "no_change" };

  await deliveryRef.child("history").push({ status, at: now });
  return { applied: true, restaurantId: idx.restaurantId, orderId: idx.orderId };
}

/** Booked delivery cancel karo (provider ko bata ke). */
async function cancelDelivery(db, restaurantId, orderId) {
  const deliveryRef = db.ref(`orders/${restaurantId}/${orderId}/delivery`);
  const d = (await deliveryRef.once("value")).val();
  if (!d || !d.provider || !d.providerOrderId) return { status: "skipped", reason: "no_booking" };
  if (TERMINAL.includes(d.status)) return { status: "skipped", reason: "already_final" };

  const p = providers.get(d.provider);
  if (!p) return { status: "skipped", reason: "unknown_provider" };

  await p.cancelOrder(d.providerOrderId);
  await deliveryRef.update({ status: "cancelled", updatedAt: Date.now() });
  return { status: "cancelled" };
}

module.exports = { bookDelivery, applyDeliveryStatus, cancelDelivery, checkEligibility };