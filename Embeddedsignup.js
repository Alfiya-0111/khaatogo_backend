// embeddedSignup.js
// Env vars (Railway):
//   META_APP_ID, META_APP_SECRET
//   WHATSAPP_REGISTER_PIN  (6 digit, sirf non-coexistence numbers ke liye chahiye)
//   META_ACCESS_TOKEN      (already hai — catalog attach ke liye)

const fetch = require("node-fetch");
const { attachCatalogToWaba, enableCommerceSettings } = require("./whatsappCatalog");

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v21.0"}`;

async function graph(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error.error_user_msg || data.error.message);
    err.meta = data.error;
    throw err;
  }
  return data;
}

// Embedded Signup ka `code` -> business token
async function exchangeCode(code) {
  const url =
    `${GRAPH}/oauth/access_token` +
    `?client_id=${process.env.META_APP_ID}` +
    `&client_secret=${process.env.META_APP_SECRET}` +
    `&code=${encodeURIComponent(code)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error || !data.access_token) {
    const err = new Error(data.error?.message || "Code exchange failed");
    err.meta = data.error;
    throw err;
  }
  return data.access_token;
}

function registerEmbeddedSignupRoutes(app, db, admin) {
  app.post("/whatsapp/embedded-signup", async (req, res) => {
    try {
      const { restaurantId, code, wabaId, phoneNumberId, coexistence } = req.body || {};
      if (!restaurantId || !code || !wabaId || !phoneNumberId) {
        return res.status(400).json({ error: "restaurantId, code, wabaId, phoneNumberId required" });
      }

      // ── 1) Sirf restaurant owner hi connect kar sake ──
      const idToken = (req.headers.authorization || "").replace(/^Bearer /, "");
      if (!idToken) return res.status(401).json({ error: "Login token missing" });
      const decoded = await admin.auth().verifyIdToken(idToken);
      const ownerSnap = await db.ref(`restaurants/${restaurantId}/ownerId`).once("value");
      const ownerId = ownerSnap.val() || restaurantId;
      if (decoded.uid !== ownerId) {
        return res.status(403).json({ error: "Sirf restaurant owner hi WhatsApp connect kar sakta hai" });
      }

      // ── 2) code -> business token ──
      const businessToken = await exchangeCode(code);

      // ── 3) Sanity check: ye phone number is token ko dikhta hai ──
      const phone = await graph(`/${phoneNumberId}?fields=display_phone_number,verified_name`, {
        token: businessToken,
      });

      // ── 4) Hamari app ko is WABA ke webhooks par subscribe karo ──
      await graph(`/${wabaId}/subscribed_apps`, { method: "POST", token: businessToken });

      // ── 5) Register: coexistence mein number app par pehle se registered hai, skip.
      //       Normal (sirf bot) onboarding mein PIN ke saath register karna padta hai.
      if (!coexistence) {
        const pin = process.env.WHATSAPP_REGISTER_PIN;
        if (!pin) throw new Error("WHATSAPP_REGISTER_PIN server par set nahi hai");
        await graph(`/${phoneNumberId}/register`, {
          method: "POST",
          token: businessToken,
          body: { messaging_product: "whatsapp", pin },
        });
      }

      // ── 6) Firebase mein save karo ──
      await db.ref(`restaurants/${restaurantId}/whatsapp`).update({
        wabaId,
        phoneNumberId,
        displayPhoneNumber: phone.display_phone_number || null,
        verifiedName: phone.verified_name || null,
        coexistence: !!coexistence,
        onboardedVia: "embedded_signup",
        connectedAt: Date.now(),
      });
      await db.ref(`phoneNumberIdToRestaurant/${phoneNumberId}`).set(restaurantId);

      // Token ko alag node mein rakho. Firebase rules mein is node ko client ke liye
      // read/write DENY rakhna (Admin SDK rules bypass karta hai).
      await db.ref(`whatsappSecrets/${restaurantId}`).set({
        businessToken,
        updatedAt: Date.now(),
      });

      // ── 7) Agar catalog pehle se bana hai to WABA se attach + cart enable ──
      let catalogAttached = false;
      const catalogSnap = await db.ref(`restaurants/${restaurantId}/metaCatalog/catalogId`).once("value");
      const catalogId = catalogSnap.val();
      if (catalogId) {
        try {
          await attachCatalogToWaba(wabaId, catalogId);
          await enableCommerceSettings(phoneNumberId);
          catalogAttached = true;
          await db.ref(`restaurants/${restaurantId}/whatsapp`).update({
            catalogAttached: true,
            catalogAttachedAt: Date.now(),
          });
        } catch (e) {
          console.error("Catalog attach after signup failed:", e.message);
        }
      }

      res.json({
        status: "connected",
        displayPhoneNumber: phone.display_phone_number || null,
        coexistence: !!coexistence,
        catalogAttached,
      });
    } catch (e) {
      console.error("Embedded signup error:", e.meta ? JSON.stringify(e.meta) : e.message);
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerEmbeddedSignupRoutes };