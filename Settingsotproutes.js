// settingsOtpRoutes.js
// Mount this in index.js (AFTER app.use(express.json()) and AFTER `db` is created):
//
//   const settingsOtpRoutes = require("./settingsOtpRoutes");
//   app.use(settingsOtpRoutes(db));
//
// Uses axios (already a dependency in this project) + bcryptjs.
// If bcryptjs isn't installed yet: npm i bcryptjs

const express = require("express");
const bcrypt = require("bcryptjs");
const axios = require("axios");

// ── Config ──
const OTP_LENGTH = 6;
const OTP_EXPIRY_MS = 5 * 60 * 1000;      // 5 minutes
const RESEND_COOLDOWN_MS = 60 * 1000;     // 60 seconds between sends
const MAX_SENDS_PER_DAY = 5;              // per restaurant
const MAX_VERIFY_ATTEMPTS = 5;            // before OTP is invalidated

const META_PHONE_NUMBER_ID = process.env.META_OTP_PHONE_NUMBER_ID;
const META_ACCESS_TOKEN = process.env.META_OTP_ACCESS_TOKEN;
const META_TEMPLATE_NAME = process.env.META_OTP_TEMPLATE_NAME;
const META_TEMPLATE_LANG = process.env.META_OTP_TEMPLATE_LANG || "en_US";

// ── Helpers ──
const genOtp = () =>
  String(Math.floor(Math.random() * 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");

const maskPhone = (phone) => {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < 4) return "••••";
  return `+${digits.slice(0, digits.length - 4).replace(/\d/g, "•")}${digits.slice(-4)}`;
};

// Convert stored phone (however it's saved — e.g. "+91 98765 43210") into
// the plain E.164 digits Meta's API expects, e.g. "919876543210".
const toWhatsappNumber = (phone) => {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return "91" + digits; // bare 10-digit Indian number
  return digits;
};

async function sendWhatsappOtp(phone, otp) {
  const to = toWhatsappNumber(phone);
  try {
    const { data } = await axios.post(
      `https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: META_TEMPLATE_NAME,
          language: { code: META_TEMPLATE_LANG },
          components: [
            { type: "body", parameters: [{ type: "text", text: otp }] },
            {
              type: "button",
              sub_type: "url",
              index: "0",
              parameters: [{ type: "text", text: otp }],
            },
          ],
        },
      },
      { headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    return data;
  } catch (e) {
    throw new Error(e.response?.data?.error?.message || e.message || "WhatsApp message bhejne mein fail hua");
  }
}

// Exported as a factory so it gets the same `db` instance index.js already created
module.exports = function settingsOtpRoutes(db) {
  const router = express.Router();

  // ══════════════════════════════════════════
  // POST /send-settings-otp   { restaurantId }
  // ══════════════════════════════════════════
  router.post("/send-settings-otp", async (req, res) => {
    try {
      const { restaurantId } = req.body;
      if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

      const [phoneSnap, otpSnap] = await Promise.all([
        db.ref(`restaurants/${restaurantId}/contact/phone`).once("value"),
        db.ref(`restaurants/${restaurantId}/settingsOtp`).once("value"),
      ]);

      const phone = phoneSnap.val();
      if (!phone) {
        return res.status(400).json({ error: "Is restaurant ke liye koi phone number saved nahi hai" });
      }

      const existing = otpSnap.val();
      const now = Date.now();

      // Cooldown between resends
      if (existing?.lastSentAt && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000);
        return res.status(429).json({ error: `${waitSec} second baad dobara try karo` });
      }

      // Daily send cap
      const dayStart = new Date().setHours(0, 0, 0, 0);
      const sentToday = existing?.dayStart === dayStart ? existing.sentCount || 0 : 0;
      if (sentToday >= MAX_SENDS_PER_DAY) {
        return res.status(429).json({ error: "Aaj ke liye OTP limit khatam ho gayi, kal try karo" });
      }

      const otp = genOtp();
      const hash = bcrypt.hashSync(otp, 10);

      await sendWhatsappOtp(phone, otp);

      await db.ref(`restaurants/${restaurantId}/settingsOtp`).set({
        hash,
        expiresAt: now + OTP_EXPIRY_MS,
        attempts: 0,
        lastSentAt: now,
        dayStart,
        sentCount: sentToday + 1,
      });

      return res.json({ success: true, phoneMasked: maskPhone(phone) });
    } catch (e) {
      console.error("send-settings-otp error:", e.message);
      return res.status(500).json({ error: e.message || "OTP bhejne mein fail hua" });
    }
  });

  // ══════════════════════════════════════════
  // POST /verify-settings-otp   { restaurantId, otp }
  // ══════════════════════════════════════════
  router.post("/verify-settings-otp", async (req, res) => {
    try {
      const { restaurantId, otp } = req.body;
      if (!restaurantId || !otp) {
        return res.status(400).json({ error: "restaurantId aur otp required hain" });
      }

      const otpRef = db.ref(`restaurants/${restaurantId}/settingsOtp`);
      const snap = await otpRef.once("value");
      const record = snap.val();

      if (!record) {
        return res.status(400).json({ error: "Pehle OTP request karo" });
      }
      if (Date.now() > record.expiresAt) {
        await otpRef.remove();
        return res.status(400).json({ error: "OTP expire ho gaya, naya bhejo" });
      }
      if ((record.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
        await otpRef.remove();
        return res.status(429).json({ error: "Bahut galat attempts ho gaye, naya OTP bhejo" });
      }

      const match = bcrypt.compareSync(String(otp), record.hash);
      if (!match) {
        await otpRef.update({ attempts: (record.attempts || 0) + 1 });
        return res.status(400).json({ error: "❌ Galat OTP" });
      }

      // Success — OTP ek hi baar use ho sakta hai
      await otpRef.remove();
      return res.json({ success: true });
    } catch (e) {
      console.error("verify-settings-otp error:", e.message);
      return res.status(500).json({ error: e.message || "Verify karne mein fail hua" });
    }
  });

  return router;
};