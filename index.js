require("dotenv").config();
const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const cors = require("cors");
const { setupAbsentJob } = require("./markAbsentJob");

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

// ══════════════════════════════════════════
// ★ FIX: JSON parser yahan, saare baaki routes ke UPAR — 
// warna neeche wale routes mein req.body undefined milega
// ══════════════════════════════════════════
app.use(express.json());

// ── Health check ──
app.get("/", (req, res) => res.send("Khaatogo payment server is running ✅"));

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
      // ★ IMPORTANT: notes mein restaurantId dalna zaroori hai,
      // taaki webhook mein "account.activated" event pe pata chal sake ye kis restaurant ka account hai
      notes: { restaurantId },
    });

    await db.ref(`restaurants/${restaurantId}/payment`).update({
      razorpayLinkedAccountId: account.id,
      razorpayAccountStatus: "created", // "created" -> "activated" (webhook se update hoga)
      razorpayCreatedAt: Date.now(),
    });

    res.json({ accountId: account.id, status: account.status });
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