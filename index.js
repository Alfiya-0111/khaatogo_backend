require("dotenv").config();
const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const admin = require("firebase-admin");
const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getAuth } = require("firebase-admin/auth");
const { registerStaffCheckinRoutes } = require("./staffCheckin");
const cors = require("cors");
const multer = require("multer");        // ★ NEW
const axios = require("axios");          // ★ NEW
const FormData = require("form-data");   
const { setupAbsentJob } = require("./markAbsentJob");
// const Settingstproutes = require("./Settingstproutes");
// ? hh
const { setupCatalogSync, upsertCatalogItem } = require("./catalogSync");
const { backfillVariants } = require("./backfillVariants");
const { dishCategoryName } = require("./categoryUtils");
const { buildCatalogEntries } = require("./catalogVariants");
// ── Firebase Admin init ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL,
});
const db = getDatabase(firebaseApp);
setupAbsentJob(db);
setupCatalogSync(db);
const { bookDelivery, applyDeliveryStatus } = require("./deliveryService");
const deliveryProviders = require("./providers");
require("./whatsappOrderBot").setDb(db);
// ── Razorpay init ──
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const app = express();

// CORS — sirf apni site allow karo
app.use(cors({
  origin: [
    "https://khaatogo.com",
    "https://www.khaatogo.com",   // ★ NEW — www wala origin bhi add karo
    "http://localhost:3000",
    "http://localhost:5173",
  ],
}));

// ══════════════════════════════════════════
// WEBHOOK — raw body chahiye signature verify karne ke liye,
// isliye ye route JSON parser (neeche wala) se PEHLE aana ZAROORI hai
// ══════════════════════════════════════════
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-razorpay-signature"];
      const expected = crypto
        .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(req.body)
        .digest("hex");

      if (signature !== expected) {
        console.log("❌ Invalid webhook signature");
        return res.status(400).send("Invalid signature");
      }

      const event = JSON.parse(req.body.toString());

          // 1) Payment successful hone par order confirm karo
      if (event.event === "payment.captured") {
        const payment = event.payload.payment.entity;
        const { restaurantId, orderId, appOrderId } = payment.notes || {};

        if (appOrderId) {
          // Khaatogo subscription payment
          await handleSubscriptionPayment(payment, appOrderId);
        } else if (restaurantId && orderId) {
          // restaurant ka customer order
          await db.ref(`orders/${restaurantId}/${orderId}`).update({
            paymentStatus: "paid_online",
            status: "confirmed",
            razorpayPaymentId: payment.id,
            paidAt: Date.now(),
          });
          console.log(`✅ Payment confirmed for order ${orderId}`);

          // delivery book karo (sirf customer order ke liye, subscription ke liye nahi)
          bookDelivery(db, restaurantId, orderId).catch((e) =>
            console.error("Delivery booking error:", e.message)
          );
        }
      }

      if (event.event === "payment.failed") {
        const payment = event.payload.payment.entity;
        const { restaurantId, orderId } = payment.notes || {};
        if (restaurantId && orderId) {
          await db.ref(`orders/${restaurantId}/${orderId}`).update({
            paymentStatus: "failed",
            failureReason: payment.error_description || "Payment failed",
          });
        }
      }

      if (event.event === "payment_link.paid") {
        const paymentLink = event.payload.payment_link.entity;
        const { restaurantId, orderId } = paymentLink.notes || {};
        if (restaurantId && orderId) {
          const updates = { status: "confirmed", paymentStatus: "paid_online", paidAt: Date.now() };
          await db.ref(`whatsappOrders/${restaurantId}/${orderId}`).update(updates);

          await db.ref(`orders/${restaurantId}/${orderId}`).update(updates);
                    bookDelivery(db, restaurantId, orderId).catch((e) =>
            console.error("Delivery booking error:", e.message)
          );
        }
      }
if (event.event === "qr_code.credited") {
  const payment = event.payload.payment.entity;
  const qrCode = event.payload.qr_code.entity;
  const { restaurantId, orderId } = qrCode.notes || {};
  if (restaurantId && orderId) {
    await db.ref(`whatsappOrders/${restaurantId}/${orderId}`).update({
      status: "confirmed", paymentStatus: "paid_online",
      razorpayPaymentId: payment.id, paidAt: Date.now(),
    });
    await db.ref(`orders/${restaurantId}/${orderId}`).update({
      status: "confirmed", paymentStatus: "paid_online",
      razorpayPaymentId: payment.id, paidAt: Date.now(),
    });
    bookDelivery(db, restaurantId, orderId).catch((e) =>
      console.error("Delivery booking error:", e.message)
    );
    // restaurant ko uska share transfer karo (Route)
    try {
      const restSnap = await db.ref(`restaurants/${restaurantId}/payment`).once("value");
      const { razorpayLinkedAccountId } = restSnap.val() || {};
      if (razorpayLinkedAccountId) {
        const commissionPercent = Number(process.env.PLATFORM_COMMISSION_PERCENT) || 2;
        const commission = Math.round(payment.amount * (commissionPercent / 100));
        await razorpay.payments.transfer(payment.id, {
          transfers: [{ account: razorpayLinkedAccountId, amount: payment.amount - commission, currency: "INR", notes: { orderId } }],
        });
      }
    } catch (e) {
      console.error("QR transfer failed:", e.error || e.message);
    }
  }
}
      // 2) Restaurant ka linked account activate hone par flag update karo
      if (event.event === "account.activated") {
        const account = event.payload.account.entity;
        const restaurantId = account.notes?.restaurantId;
        if (restaurantId) {
          await db.ref(`restaurants/${restaurantId}/payment`).update({
            razorpayAccountStatus: "activated",
          });
          console.log(`✅ Restaurant ${restaurantId} ka account activate ho gaya`);
        }
      }

      res.json({ status: "ok" });
    } catch (e) {
      console.error("Webhook error:", e);
      res.status(500).send("Webhook processing failed");
    }
  }
);
// Subscription payment ko paymentRequests mein likhta hai
async function handleSubscriptionPayment(payment, appOrderId) {
  const pend = (await db.ref(`pendingPayments/${appOrderId}`).once("value")).val();
  if (!pend) return;

  const key = payment.id;
  // webhook retry ho to duplicate na bane
  const exists = (await db.ref(`paymentRequests/${key}`).once("value")).exists();
  if (exists) return;

  const now = Date.now();
  await db.ref(`paymentRequests/${key}`).set({
    ...pend,
    razorpayPaymentId: payment.id,
    razorpayOrderId: payment.order_id,
    orderId: appOrderId,
    status: "pending",
    paymentMethod: "razorpay",
    submittedAt: now,
  });
  await db.ref(`userPaymentRequests/${pend.userId}/${key}`).set({
    status: "pending", amount: pend.amount, planId: pend.planId,
    planName: pend.planName, orderId: appOrderId,
    razorpayPaymentId: payment.id, submittedAt: now,
  });
  await db.ref("adminNotifications/payments").push({
    type: "razorpay_payment", paymentId: key, orderId: appOrderId,
    userId: pend.userId, userEmail: pend.userEmail, userName: pend.userName,
    amount: pend.amount, planName: pend.planName, planId: pend.planId,
    message: `Razorpay ₹${pend.amount} for ${pend.planName}. ID: ${payment.id}`,
    status: "pending_verification", createdAt: now, read: false, actionRequired: true,
  });
  await db.ref(`notifications/${pend.userId}`).push({
    title: "💳 Payment Received!",
    message: `${pend.planName} plan (₹${pend.amount}) verify ho raha hai. 24 ghante mein activate ho jayega.`,
    type: "payment", createdAt: now, read: false,
  });
  await db.ref(`pendingPayments/${appOrderId}/status`).set("paid");
}
app.post("/webhook/kronos", async (req, res) => {
  try {
    console.log("Kronos webhook payload:", JSON.stringify(req.body, null, 2));
    res.json({ status: "received" });
  } catch (e) {
    console.error("Kronos webhook error:", e);
    res.status(500).json({ error: e.message });
  }
});
// Delivery provider (Porter/Rapido) ke status updates
app.post("/webhook/delivery/:provider", express.raw({ type: "*/*" }), async (req, res) => {
  const provider = deliveryProviders.get(req.params.provider);
  if (!provider) return res.sendStatus(404);
  try {
    const evt = provider.parseWebhook({ rawBody: req.body, headers: req.headers });
    await applyDeliveryStatus(db, provider.name, evt.providerOrderId, evt.status, evt.extra || {});
    res.json({ status: "ok" });
  } catch (e) {
    if (e.code === "NOT_READY") return res.sendStatus(501);
    if (e.code === "BAD_SIGNATURE") return res.sendStatus(401);
    console.error("Delivery webhook error:", e.message);
    res.status(500).send("Webhook processing failed");
  }
});
// ══════════════════════════════════════════
// ★ FIX: JSON parser yahan, saare baaki routes ke UPAR — 
// warna neeche wale routes mein req.body undefined milega
// ══════════════════════════════════════════
app.use(express.json());
// Restaurant owner failed / needs_location delivery ko dobara try kare
app.post("/book-delivery", async (req, res) => {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Login required" });
    const decoded = await getAuth(firebaseApp).verifyIdToken(token);

    const { restaurantId, orderId } = req.body;
    if (!restaurantId || !orderId) return res.status(400).json({ error: "restaurantId aur orderId required" });

    const ownerSnap = await db.ref(`restaurants/${restaurantId}/ownerId`).once("value");
    const ownerId = ownerSnap.val() || restaurantId;
    if (decoded.uid !== ownerId) return res.status(403).json({ error: "Not allowed" });

    const result = await bookDelivery(db, restaurantId, orderId, { force: true });
    res.json(result);
  } catch (e) {
    console.error("Book delivery error:", e.message);
    res.status(500).json({ error: e.message });
  }
});
// Subscription ke liye Razorpay order (platform account mein, koi transfer nahi)
// ── Subscription pricing (SubscriptionPage jaisa hi rakho) ──
const SUB_PLANS = {
  starter:    { name: "Starter",     price: 299, dishes: 60, dishPrice: 5, hasAddons: true },
  growth:     { name: "Growth",      price: 599, dishes: 90, dishPrice: 5 },
  pro:        { name: "Pro",         price: 999, dishes: null },
  stallBasic: { name: "Stall Basic", price: 99,  dishes: 30, dishPrice: 3 },
  stallPlus:  { name: "Stall Plus",  price: 199, dishes: 45, dishPrice: 3 },
  stallPro:   { name: "Stall Pro",   price: 299, dishes: 60, dishPrice: 3 },
  stallMax:   { name: "Stall Max",   price: 399, dishes: 80, dishPrice: 3 },
};

const SUB_ADDONS = {
  tableBooking: 100, customerFeedback: 100, adminCoupons: 100, waiterStats: 100,
  deliveryBoys: 250, revenueDashboard: 250, expenses: 250, customers: 250,
};

function calcSubscriptionPrice({ planId, selectedAddons, extraDishCount, billingCycle }) {
  const plan = SUB_PLANS[planId];
  if (!plan) throw new Error("Invalid plan");

  let monthly = plan.price;

  let extra = parseInt(extraDishCount, 10) || 0;
  if (extra < 0) extra = 0;
  if (extra > 500) throw new Error("Too many extra dishes");
  if (plan.dishPrice) monthly += extra * plan.dishPrice;
  else extra = 0;

  let addons = [];
  if (plan.hasAddons) {
    addons = [...new Set(Array.isArray(selectedAddons) ? selectedAddons : [])]
      .filter((id) => SUB_ADDONS[id] !== undefined);
    monthly += addons.reduce((s, id) => s + SUB_ADDONS[id], 0);
  }

  const yearly = billingCycle === "yearly";
  const amount = yearly ? Math.round(monthly * 12 * 0.8) : monthly;
  const maxDishes = plan.dishes === null ? "Unlimited" : plan.dishes + extra;

  return { amount, plan, addons, extra, maxDishes, billingCycle: yearly ? "yearly" : "monthly" };
}

// Subscription ke liye Razorpay order
app.post("/create-subscription-order", async (req, res) => {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Login required" });
    const decoded = await getAuth(firebaseApp).verifyIdToken(token);
    const uid = decoded.uid;

    const d = req.body;
    let calc;
    try {
      calc = calcSubscriptionPrice(d);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const appOrderId = `order_${Date.now()}_${uid}`;
    const order = await razorpay.orders.create({
      amount: calc.amount * 100,
      currency: "INR",
      receipt: appOrderId.slice(0, 40),
      payment_capture: 1,
      notes: { userId: uid, appOrderId, planId: d.planId },
    });

    await db.ref(`pendingPayments/${appOrderId}`).set({
      userId: uid,
      userEmail: decoded.email || "",
      userName: decoded.name || "User",
      planId: d.planId,
      planName: calc.plan.name,
      amount: calc.amount,
      selectedAddons: calc.addons,
      extraDishCount: calc.extra,
      maxDishes: calc.maxDishes,
      planFeatures: d.planFeatures || {},
      billingCycle: calc.billingCycle,
      razorpayOrderId: order.id,
      status: "created",
      createdAt: Date.now(),
    });

    res.json({ razorpayOrderId: order.id, orderId: appOrderId, amount: calc.amount });
  } catch (e) {
    console.error("Subscription order error:", e.error || e.message);
    res.status(500).json({ error: e.error?.description || e.message });
  }
});
const { registerEmbeddedSignupRoutes } = require("./Embeddedsignup");
registerEmbeddedSignupRoutes(app, db, admin);
registerStaffCheckinRoutes(app, db);
// app.use(Settingstproutes(db));
// ★ NEW: Multer setup — file uploads memory mein handle karega
// ══════════════════════════════════════════
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
});
// ── Health check ──
app.get("/", (req, res) => res.send("Khaatogo payment server is running ✅"));
// ══════════════════════════════════════════
// Meta Catalog ke liye CSV feed — Meta khud is URL ko periodically fetch karega
// ══════════════════════════════════════════
app.get("/catalog-feed.csv", async (req, res) => {
  try {
    const snap = await db.ref("restaurants").once("value");
    const restaurants = snap.val() || {};

    const csvField = (val) =>
      `"${String(val ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;

      const HEADER = [
      "id", "title", "description", "availability", "condition", "price",
      "link", "image_link", "brand", "custom_label_0",
    ];
    const rows = [HEADER.join(",")];

    for (const [restaurantId, rData] of Object.entries(restaurants)) {
      const menu = rData.menu || {};
    const categoriesData = rData.categories || {};
           const lat = rData.attendanceGeofence?.lat ?? "";
      const lng = rData.attendanceGeofence?.lng ?? "";
      const radiusKm = 5;

          for (const [dishId, dish] of Object.entries(menu)) {
        const baseId = `${restaurantId}_${dishId}`;
        const description = dish.description || dish.name || "";
        const availability =
          dish.inStock !== false && dish.remainingQuantity !== 0 ? "in stock" : "out of stock";
        const link = `https://khaatogo.com/menu/${restaurantId}?item=${dishId}`;
        const image = dish.imageUrl || "https://via.placeholder.com/400";
        const category = dishCategoryName(dish, categoriesData);

        for (const e of buildCatalogEntries(dish)) {
          if (e.price <= 0) continue;
          rows.push(
            [
              csvField(`${baseId}${e.idSuffix}`), csvField(e.name), csvField(description),
              csvField(availability), csvField("new"), csvField(`${e.price.toFixed(2)} INR`),
              csvField(link), csvField(image), csvField(rData.name || "Khaatogo"),
              csvField(category),
            ].join(",")
          );
        }
      }
    }

    res.set("Content-Type", "text/csv");
    res.send(rows.join("\n"));
  } catch (e) {
    console.error("Catalog feed error:", e);
    res.status(500).send("Error generating feed");
  }
});
app.get("/catalog-feed/:restaurantId.csv", async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const rSnap = await db.ref(`restaurants/${restaurantId}`).once("value");
    const rData = rSnap.val();

    if (!rData) {
      return res.status(404).send("Restaurant not found");
    }

    const csvField = (val) =>
      `"${String(val ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;

        const HEADER = [
      "id", "title", "description", "availability", "condition", "price",
      "link", "image_link", "brand", "custom_label_0",
      "availability_circle_origin.latitude",
      "availability_circle_origin.longitude",
      "availability_circle_radius",
      "availability_circle_radius_unit",
    ];
    const rows = [HEADER.join(",")];

    const menu = rData.menu || {};
        const categoriesData = rData.categories || {};
    const lat = rData.attendanceGeofence?.lat ?? "";
    const lng = rData.attendanceGeofence?.lng ?? "";
    const radiusKm = 5;

      for (const [dishId, dish] of Object.entries(menu)) {
      const baseId = `${restaurantId}_${dishId}`;
      const description = dish.description || dish.name || "";
      const availability =
        dish.inStock !== false && dish.remainingQuantity !== 0 ? "in stock" : "out of stock";
      const link = `https://khaatogo.com/menu/${restaurantId}?item=${dishId}`;
      const image = dish.imageUrl || "https://via.placeholder.com/400";
      const category = dishCategoryName(dish, categoriesData);

      // Full/base + har Half/variant ke liye alag row
      for (const e of buildCatalogEntries(dish)) {
        if (e.price <= 0) continue;
        rows.push(
          [
            csvField(`${baseId}${e.idSuffix}`), csvField(e.name), csvField(description),
            csvField(availability), csvField("new"), csvField(`${e.price.toFixed(2)} INR`),
            csvField(link), csvField(image), csvField(rData.name || "Khaatogo"),
            csvField(category),
            csvField(lat), csvField(lng), csvField(radiusKm), csvField("km"),
          ].join(",")
        );
      }
    }

    res.set("Content-Type", "text/csv");
    res.send(rows.join("\n"));
  } catch (e) {
    console.error("Per-restaurant catalog feed error:", e);
    res.status(500).send("Error generating feed");
  }
});



const { sendButtons } = require("./whatsappOrderBot"); // ★ NEW

const { handleIncomingMessage } = require("./whatsappOrderHandler"); // ★ NEW
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN; // ★ NEW

// ══════════════════════════════════════════
// ★ NEW: Meta webhook verification (ek baar setup ke waqt call hoga)
// ══════════════════════════════════════════
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});
// ══════════════════════════════════════════
const { decryptRequest, encryptResponse } = require("./flowEndpoint");
const { handleFlowDataExchange } = require("./flowOrderLogic");

// ★ NEW: WhatsApp Flow ka data-exchange endpoint (encrypted)

// ══════════════════════════════════════════
app.post("/webhook/whatsapp-flow", async (req, res) => {
  try {
    const privatePem = process.env.PRIVATE_KEY;
    const { decryptedBody, aesKey, ivBuffer } = decryptRequest(req.body, privatePem);

    let responseObj;
    if (decryptedBody.action === "ping") {
      responseObj = { data: { status: "active" } };
    } else {
      const flowToken = decryptedBody.flow_token || "";
      const [restaurantId, from] = flowToken.split("|");
      responseObj = await handleFlowDataExchange(db, restaurantId, from, decryptedBody);
    }

    const encrypted = encryptResponse(responseObj, aesKey, ivBuffer);
    // console.log("Encrypted response length:", encrypted.length, "| preview:", encrypted.slice(0, 50));

    res.set("Content-Type", "text/plain");
    res.send(encrypted);
  } catch (e) {
    console.error("Flow endpoint error:", e);
    res.sendStatus(432);
  }
});
// ══════════════════════════════════════════
// ★ NEW: Customer ke WhatsApp messages/orders yahan aate hain
// ══════════════════════════════════════════
app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200); // Meta ko turant acknowledge karo
  try {
  const change = req.body.entry?.[0]?.changes?.[0];
if (change?.field !== "messages") return;
const value = change.value;
    const phoneNumberId = value?.metadata?.phone_number_id;
    const message = value?.messages?.[0];
    if (!message || !phoneNumberId) return;

   const mapSnap = await db.ref(`phoneNumberIdToRestaurant/${phoneNumberId}`).once("value");
const restaurantId = mapSnap.val();
console.log(`📱 WhatsApp msg — phoneNumberId: ${phoneNumberId} → restaurantId: ${restaurantId}`); // ★ NEW
if (!restaurantId) {
      console.log("Unknown phoneNumberId:", phoneNumberId);
      return;
    }

   await handleIncomingMessage(db, razorpay, message, phoneNumberId, restaurantId);
  } catch (e) {
    console.error("WhatsApp webhook error:", e);
  }
});

const { createRestaurantCatalog } = require("./createRestaurantCatalog");

// ══════════════════════════════════════════
// ★ NEW: Restaurant ke liye Meta catalog + feed + sharing automate karo
// ══════════════════════════════════════════
app.post("/create-restaurant-catalog", async (req, res) => {
  try {
    const { restaurantId, metaBusinessId } = req.body;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const rSnap = await db.ref(`restaurants/${restaurantId}`).once("value");
    const rData = rSnap.val();
    if (!rData) return res.status(404).json({ error: "Restaurant not found" });

   if (!process.env.META_BUSINESS_ID) {
  return res.status(500).json({ error: "META_BUSINESS_ID server par set nahi hai" });
}

const result = await createRestaurantCatalog(
  restaurantId,
  rData.name,
  process.env.META_BUSINESS_ID
);

    await db.ref(`restaurants/${restaurantId}/metaCatalog`).update({
      catalogId: result.catalogId,
      feedId: result.feedId,
      createdAt: Date.now(),
    });

    res.json({ status: "created", ...result });
  } catch (e) {
    console.error("Create restaurant catalog error:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post("/test-attach-existing-catalog", async (req, res) => {
  try {
    const { restaurantId } = req.body;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    await db.ref(`restaurants/${restaurantId}/metaCatalog`).update({
      catalogId: process.env.META_CATALOG_ID,
      attachedManually: true,
      createdAt: Date.now(),
    });

    res.json({ status: "attached", catalogId: process.env.META_CATALOG_ID });
  } catch (e) {
    console.error("Test attach error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/test-catalog-sync", async (req, res) => {
  try {
    const { restaurantId, dishId } = req.body;
    if (!restaurantId || !dishId) {
      return res.status(400).json({ error: "restaurantId aur dishId required" });
    }

    const dishSnap = await db.ref(`restaurants/${restaurantId}/menu/${dishId}`).once("value");
    const dish = dishSnap.val();
    if (!dish) return res.status(404).json({ error: "Dish not found" });

    const geoSnap = await db.ref(`restaurants/${restaurantId}/attendanceGeofence`).once("value");
    const geo = geoSnap.val() || {};

    const result = await upsertCatalogItem(db, restaurantId, dishId, dish, geo);
    res.json({ status: "sync_attempted", result });
  } catch (e) {
    console.error("Test sync error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ══════════════════════════════════════════
// ★ NEW: Restaurant ka catalog WhatsApp Business Account se attach karo
// ══════════════════════════════════════════
const { attachCatalogToWaba, enableCommerceSettings, subscribeAppToWaba, createProductSetsByCategory, syncCategoryCollections } = require("./whatsappCatalog");

app.post("/sync-category-collections", async (req, res) => {
  try {
    const { restaurantId } = req.body;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const [catalogSnap, menuSnap, catSnap] = await Promise.all([
      db.ref(`restaurants/${restaurantId}/metaCatalog/catalogId`).once("value"),
      db.ref(`restaurants/${restaurantId}/menu`).once("value"),
      db.ref(`restaurants/${restaurantId}/categories`).once("value"),
    ]);
    const catalogId = catalogSnap.val();
    if (!catalogId) return res.status(400).json({ error: "metaCatalog/catalogId missing" });

    const menu = menuSnap.val() || {};
    const categoriesData = catSnap.val() || {};
    const names = [...new Set(Object.values(menu).map((d) => dishCategoryName(d, categoriesData)))];

    const result = await syncCategoryCollections(catalogId, names);
    res.json({ status: "ok", categories: names, ...result });
  } catch (e) {
    console.error("Sync collections error:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post("/attach-whatsapp-catalog", async (req, res) => {
  try {
    const { restaurantId, wabaId, phoneNumberId } = req.body;

    if (!restaurantId || !wabaId) {
      return res.status(400).json({ error: "restaurantId aur wabaId required" });
    }

    const catalogSnap = await db.ref(`restaurants/${restaurantId}/metaCatalog`).once("value");
    const { catalogId } = catalogSnap.val() || {};

    if (!catalogId) {
      return res.status(400).json({
        error: "Pehle catalog banao — /create-restaurant-catalog call karo",
      });
    }

    const result = await attachCatalogToWaba(wabaId, catalogId);

    // ★ app ko WABA se subscribe karo taaki messages webhook aaye
    const subscribeResult = await subscribeAppToWaba(wabaId);

    let commerceResult = null;
    if (phoneNumberId) {
      commerceResult = await enableCommerceSettings(phoneNumberId);
    }

    await db.ref(`restaurants/${restaurantId}/whatsapp`).update({
      wabaId,
      phoneNumberId: phoneNumberId || null,
      catalogAttachedAt: Date.now(),
      catalogAttached: true,
    });

    if (phoneNumberId) {
      await db.ref(`phoneNumberIdToRestaurant/${phoneNumberId}`).set(restaurantId);
    }

    res.json({ status: "attached", result, commerceResult, subscribeResult });
  } catch (e) {
    console.error("Attach WhatsApp catalog error:", e.message);
    res.status(500).json({ error: e.message });
  }
});
// ══════════════════════════════════════════
// RESTAURANT ka Linked Account banao (bank onboarding — step 1)
// ══════════════════════════════════════════
app.post("/create-linked-account", async (req, res) => {
  try {
    const {
      restaurantId,
      businessName,
      email,
      phone,
      panNumber,
      businessType, // "individual" | "proprietorship" | "partnership" etc.
    } = req.body;

    if (!restaurantId || !businessName || !email || !phone || !panNumber) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ★ NEW: phone number clean karo — Razorpay ko sirf 10 digit number chahiye, +91/spaces nahi
    const cleanPhone = String(phone).replace(/\D/g, "").slice(-10);
    if (cleanPhone.length !== 10) {
      return res.status(400).json({ error: "Phone number invalid hai — 10 digit number chahiye" });
    }

    // ★ NEW: PAN format bhi check kar lo (5 letters + 4 digits + 1 letter)
    const cleanPan = String(panNumber).toUpperCase().trim();
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(cleanPan)) {
      return res.status(400).json({ error: "PAN number ka format galat hai (example: ABCDE1234F)" });
    }

      const account = await razorpay.accounts.create({
      email,
      phone: cleanPhone,
      type: "route",
      legal_business_name: businessName,
      business_type: businessType || "individual",
      contact_name: businessName,
      profile: {
        category: "food",
        subcategory: "restaurant",
        addresses: {
          registered: {
            street1: "N/A",
            city: "N/A",
            state: "N/A",
            postal_code: "000000",
            country: "IN",
          },
        },
      },
      legal_info: {
        pan: cleanPan,
      },
      notes: { restaurantId },
    });

    // ★ NEW: Route product explicitly request karo — bina iske account activate nahi hoga
    let productId = null;
    try {
      const productRes = await razorpay.products.requestProductConfiguration(account.id, {
        product_name: "route",
        tnc_accepted: true,
      });
      productId = productRes.id;
    } catch (prodErr) {
      console.error("Route product request failed:", prodErr.error || prodErr.message);
    }

    await db.ref(`restaurants/${restaurantId}/payment`).update({
      razorpayLinkedAccountId: account.id,
      razorpayProductId: productId, // ★ NEW: KYC document upload ke liye chahiye
      razorpayAccountStatus: "created",
      razorpayCreatedAt: Date.now(),
    });

    res.json({ accountId: account.id, status: account.status, productId });
  } catch (e) {
    console.error("Linked account creation error:", e.error || e.message);
    res.status(500).json({ error: e.error?.description || e.message });
  }
});

// ══════════════════════════════════════════
// Bank account link karo (bank onboarding — step 2)
// ══════════════════════════════════════════
app.post("/link-bank-account", async (req, res) => {
  try {
    const {
      restaurantId,
      accountNumber,
      ifscCode,
      beneficiaryName,
      email,
      panNumber,
    } = req.body;

    if (!restaurantId || !accountNumber || !ifscCode || !beneficiaryName) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const restSnap = await db.ref(`restaurants/${restaurantId}/payment`).once("value");
    const { razorpayLinkedAccountId } = restSnap.val() || {};

    if (!razorpayLinkedAccountId) {
      return res.status(400).json({ error: "Pehle linked account banao (create-linked-account call karo)" });
    }

    await razorpay.accounts.createStakeholder(razorpayLinkedAccountId, {
      name: beneficiaryName,
      email,
      kyc: { pan: panNumber },
      bank_account: {
        beneficiary_name: beneficiaryName,
        ifsc_code: ifscCode,
        account_number: accountNumber,
      },
    });

    await db.ref(`restaurants/${restaurantId}/payment`).update({
      razorpayBankLinkedAt: Date.now(),
    });

    res.json({ status: "bank_linked" });
  } catch (e) {
    console.error("Bank link error:", e.error || e.message);
    res.status(500).json({ error: e.error?.description || e.message });
  }
});
// ══════════════════════════════════════════
// ★ NEW: KYC documents upload karo (PAN + bank proof) — Route activation ke liye zaroori
// ══════════════════════════════════════════
app.post(
  "/upload-kyc-document",
  upload.fields([
    { name: "businessProof", maxCount: 1 },
    { name: "bankProof", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { restaurantId } = req.body;
      if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

      const paySnap = await db.ref(`restaurants/${restaurantId}/payment`).once("value");
      const { razorpayLinkedAccountId, razorpayProductId } = paySnap.val() || {};

      if (!razorpayLinkedAccountId || !razorpayProductId) {
        return res.status(400).json({ error: "Pehle linked account bano (create-linked-account call karo)" });
      }

      const authCreds = {
        username: process.env.RAZORPAY_KEY_ID,
        password: process.env.RAZORPAY_KEY_SECRET,
      };

      const uploadedDocs = {};

      if (req.files?.businessProof?.[0]) {
        const file = req.files.businessProof[0];
        const form = new FormData();
        form.append("file", file.buffer, { filename: file.originalname, contentType: file.mimetype });
        form.append("document_type", "business_proof_url");

        const docRes = await axios.post(
          `https://api.razorpay.com/v2/accounts/${razorpayLinkedAccountId}/stakeholders/documents`,
          form,
          { auth: authCreds, headers: form.getHeaders() }
        );
        uploadedDocs.businessProof = docRes.data;
      }

      if (req.files?.bankProof?.[0]) {
        const file = req.files.bankProof[0];
        const form = new FormData();
        form.append("file", file.buffer, { filename: file.originalname, contentType: file.mimetype });
        form.append("document_type", "bank_proof_url");

        const docRes = await axios.post(
          `https://api.razorpay.com/v2/accounts/${razorpayLinkedAccountId}/products/${razorpayProductId}/documents`,
          form,
          { auth: authCreds, headers: form.getHeaders() }
        );
        uploadedDocs.bankProof = docRes.data;
      }

      await db.ref(`restaurants/${restaurantId}/payment`).update({
        kycDocsUploadedAt: Date.now(),
        kycDocsStatus: "submitted",
      });

      res.json({ status: "documents_submitted", uploadedDocs });
    } catch (e) {
      console.error("KYC doc upload error:", e.response?.data || e.message);
      res.status(500).json({ error: e.response?.data?.error?.description || e.message });
    }
  }
);
// ══════════════════════════════════════════
// ORDER banao — restaurant ko payment split karke (Route transfers)
// ══════════════════════════════════════════
app.post("/create-order", async (req, res) => {
  try {
    const { restaurantId, orderId, amount } = req.body;

    if (!restaurantId || !orderId || !amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid request data" });
    }

    // ★ Security: amount frontend se trust nahi karte — Firebase se dobara verify karo
    const orderSnap = await db.ref(`orders/${restaurantId}/${orderId}`).once("value");
    if (!orderSnap.exists()) {
      return res.status(404).json({ error: "Order not found" });
    }
    const serverAmount = Number(orderSnap.val().total) || 0;
    if (Math.abs(serverAmount - amount) > 1) {
      return res.status(400).json({ error: "Amount mismatch" });
    }
    // ...baaki sab jaisa tha waisa hi rakho
    if (!orderSnap.exists()) {
      return res.status(404).json({ error: "Order not found" });
    }
   

    // Restaurant ka linked account check karo
    const restSnap = await db.ref(`restaurants/${restaurantId}/payment`).once("value");
    const { razorpayLinkedAccountId, razorpayAccountStatus } = restSnap.val() || {};

    if (!razorpayLinkedAccountId || razorpayAccountStatus !== "activated") {
      return res.status(400).json({
        error: "Restaurant ka bank account setup nahi hua hai. Owner ko Settings se bank account connect karna hoga.",
      });
    }

    const commissionPercent = Number(process.env.PLATFORM_COMMISSION_PERCENT) || 2;
    const totalPaisa = Math.round(serverAmount * 100);
    const commission = Math.round(totalPaisa * (commissionPercent / 100));
    const restaurantShare = totalPaisa - commission;

    const rpOrder = await razorpay.orders.create({
      amount: totalPaisa,
      currency: "INR",
      receipt: orderId,
      notes: { restaurantId, orderId },
      transfers: [
        {
          account: razorpayLinkedAccountId,
          amount: restaurantShare,
          currency: "INR",
          notes: { orderId },
          on_hold: false,
        },
      ],
    });

    res.json({
      razorpayOrderId: rpOrder.id,
      amount: rpOrder.amount,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (e) {
    console.error("Create order error:", e.error || e.message);
    res.status(500).json({ error: e.error?.description || e.message });
  }
});
app.get("/admin/backfill-variants", async (req, res) => {
  if (!process.env.BACKFILL_KEY || req.query.key !== process.env.BACKFILL_KEY) {
    return res.status(403).send("Forbidden");
  }
  res.send("Backfill started, Railway logs dekho");
  backfillVariants(db).catch((e) => console.error("Backfill error:", e));
});
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));