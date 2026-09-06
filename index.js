require("dotenv").config();
const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const cors = require("cors");
const multer = require("multer");        // ★ NEW
const axios = require("axios");          // ★ NEW
const FormData = require("form-data");   
const { setupAbsentJob } = require("./markAbsentJob");
const { setupCatalogSync } = require("./catalogSync");

// ── Firebase Admin init ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const firebaseApp = admin.initializeApp({
  credential: admin.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL,
});
const db = getDatabase(firebaseApp);
setupAbsentJob(db);

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
    "http://localhost:3000",
    "http://localhost:5173",   // ← apna actual frontend port yahan daalo
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
        const { restaurantId, orderId } = payment.notes || {};
        if (restaurantId && orderId) {
          await db.ref(`orders/${restaurantId}/${orderId}`).update({
            paymentStatus: "paid_online",
            status: "confirmed",
            razorpayPaymentId: payment.id,
            paidAt: Date.now(),
          });
          console.log(`✅ Payment confirmed for order ${orderId}`);
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
app.post("/webhook/kronos", async (req, res) => {
  try {
    console.log("Kronos webhook payload:", JSON.stringify(req.body, null, 2));
    res.json({ status: "received" });
  } catch (e) {
    console.error("Kronos webhook error:", e);
    res.status(500).json({ error: e.message });
  }
});
// ══════════════════════════════════════════
// ★ FIX: JSON parser yahan, saare baaki routes ke UPAR — 
// warna neeche wale routes mein req.body undefined milega
// ══════════════════════════════════════════
app.use(express.json());
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
      "link", "image_link", "brand",
      "availability_circle_origin.latitude",
      "availability_circle_origin.longitude",
      "availability_circle_radius",
      "availability_circle_radius_unit",
    ];
    const rows = [HEADER.join(",")];

    for (const [restaurantId, rData] of Object.entries(restaurants)) {
      const menu = rData.menu || {};

           const lat = rData.attendanceGeofence?.lat ?? "";
      const lng = rData.attendanceGeofence?.lng ?? "";
      const radiusKm = 5;

      for (const [dishId, dish] of Object.entries(menu)) {
        const id = `${restaurantId}_${dishId}`;
        const title = dish.name || "";
        const description = dish.description || dish.name || "";
        const availability =
          dish.inStock !== false && dish.remainingQuantity !== 0 ? "in stock" : "out of stock";
        const price = `${(Number(dish.price) || 0).toFixed(2)} INR`;
        const link = `https://khaatogo.com/menu/${restaurantId}?item=${dishId}`;
        const image = dish.imageUrl || "https://via.placeholder.com/400";

        rows.push(
          [
            csvField(id), csvField(title), csvField(description),
            csvField(availability), csvField("new"), csvField(price),
            csvField(link), csvField(image), csvField("Khaatogo"),
            csvField(lat), csvField(lng), csvField(radiusKm), csvField("km"),
          ].join(",")
        );
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
      "link", "image_link", "brand",
      "availability_circle_origin.latitude",
      "availability_circle_origin.longitude",
      "availability_circle_radius",
      "availability_circle_radius_unit",
    ];
    const rows = [HEADER.join(",")];

    const menu = rData.menu || {};
    const lat = rData.attendanceGeofence?.lat ?? "";
    const lng = rData.attendanceGeofence?.lng ?? "";
    const radiusKm = 5;

    for (const [dishId, dish] of Object.entries(menu)) {
      const id = `${restaurantId}_${dishId}`;
      const title = dish.name || "";
      const description = dish.description || dish.name || "";
      const availability =
        dish.inStock !== false && dish.remainingQuantity !== 0 ? "in stock" : "out of stock";
      const price = `${(Number(dish.price) || 0).toFixed(2)} INR`;
      const link = `https://khaatogo.com/menu/${restaurantId}?item=${dishId}`;
      const image = dish.imageUrl || "https://via.placeholder.com/400";

      rows.push(
        [
          csvField(id), csvField(title), csvField(description),
          csvField(availability), csvField("new"), csvField(price),
          csvField(link), csvField(image), csvField(rData.name || "Khaatogo"),
          csvField(lat), csvField(lng), csvField(radiusKm), csvField("km"),
        ].join(",")
      );
    }

    res.set("Content-Type", "text/csv");
    res.send(rows.join("\n"));
  } catch (e) {
    console.error("Per-restaurant catalog feed error:", e);
    res.status(500).send("Error generating feed");
  }
});
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
// ★ NEW: Customer ke WhatsApp messages/orders yahan aate hain
// ══════════════════════════════════════════
app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200); // Meta ko turant acknowledge karo
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const phoneNumberId = value?.metadata?.phone_number_id;
    const message = value?.messages?.[0];
    if (!message || !phoneNumberId) return;

    const mapSnap = await db.ref(`phoneNumberIdToRestaurant/${phoneNumberId}`).once("value");
    const restaurantId = mapSnap.val();
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
    const { restaurantId } = req.body;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const rSnap = await db.ref(`restaurants/${restaurantId}`).once("value");
    const rData = rSnap.val();
    if (!rData) return res.status(404).json({ error: "Restaurant not found" });

    if (!rData.metaBusinessId) {
      return res.status(400).json({
        error: "Restaurant ne apna Meta Business Manager ID nahi diya hai — Settings mein set karwao",
      });
    }

    const result = await createRestaurantCatalog(restaurantId, rData.name, rData.metaBusinessId);

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
const { attachCatalogToWaba, enableCommerceSettings } = require("./whatsappCatalog"); // ★ NEW

// ══════════════════════════════════════════
// ★ NEW: Restaurant ka catalog WhatsApp Business Account se attach karo
// ══════════════════════════════════════════
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
  await db.ref(`phoneNumberIdToRestaurant/${phoneNumberId}`).set(restaurantId); // ★ NEW
}
    res.json({ status: "attached", result, commerceResult });
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));