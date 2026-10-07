// whatsappOrderHandler.js
const admin = require("firebase-admin");
const { sendText, sendButtons, sendImage, sendProductList, sendFlowMessage, sendList, sendCatalogMessage } = require("./whatsappOrderBot");
const { billSummaryText } = require("./billUtils");

const { getFirestore } = require("firebase-admin/firestore");

async function getDishDetails(db, restaurantId, dishId) {
  const snap = await db.ref(`restaurants/${restaurantId}/menu/${dishId}`).once("value");
  let dish = snap.val();

  if (!dish) {
    try {
      const fsSnap = await getFirestore().collection("menu").doc(dishId).get();
      if (fsSnap.exists) dish = fsSnap.data();
    } catch (e) {
      console.error("Firestore dish lookup failed:", e.message);
    }
  }

  dish = dish || {};
  return {
    name: dish.name || "Item",
    prepTime: Number(dish.prepTime) || 15,
    image: dish.imageUrl || dish.image || "",
    dishTasteProfile: dish.dishTasteProfile || "normal",
    saltLevelEnabled: !!dish.saltLevelEnabled,
    sugarLevelEnabled: !!dish.sugarLevelEnabled,
    saladConfig: dish.saladConfig || null,
  };
}
// Row description max 72 chars hota hai
function namesPreview(names, max = 72) {
  let out = "";
  for (const n of names) {
    const next = out ? `${out}, ${n}` : n;
    if (next.length > max - 3 && out) return (out + "...").slice(0, max);
    out = next;
  }
  return out.slice(0, max);
}
// Menu ko category ke hisaab se group karo (sirf in-stock dishes)
async function loadMenuGroups(db, restaurantId) {
  const [menuSnap, catSnap] = await Promise.all([
    db.ref(`restaurants/${restaurantId}/menu`).once("value"),
    db.ref(`restaurants/${restaurantId}/categories`).once("value"),
  ]);
  const menu = menuSnap.val() || {};
  const categoriesData = catSnap.val() || {};
  const groups = {}; // key -> { name, items: [retailerId] }

  for (const [dishId, dish] of Object.entries(menu)) {
    if (dish.inStock === false || dish.remainingQuantity === 0) continue;
    const retailerId = `${restaurantId}_${dishId}`;

    const cats = [];
    if (Array.isArray(dish.categoryIds) && dish.categoryIds.length > 0) {
      dish.categoryIds.forEach((cid) => {
        const name = categoriesData[cid]?.name;
        if (name) cats.push({ key: cid, name });
      });
    } else if (dish.category) {
      cats.push({ key: dish.category, name: dish.category });
    }
    if (cats.length === 0) cats.push({ key: "other", name: "Other" });

      cats.forEach(({ key, name }) => {
      if (!groups[key]) groups[key] = { name, items: [], dishNames: [] };
      if (!groups[key].items.includes(retailerId)) {
        groups[key].items.push(retailerId);
        groups[key].dishNames.push(dish.name || "Item");
      }
    });
  }
  return groups;
}

const CATEGORIES_PER_PAGE = 9;

async function sendCategoryList(db, phoneNumberId, from, restaurantId, page = 0) {
  const nameSnap = await db.ref(`restaurants/${restaurantId}/name`).once("value");
  const restaurantName = nameSnap.val() || "our restaurant";
  const entries = Object.entries(await loadMenuGroups(db, restaurantId));

  if (entries.length === 0) {
    await sendText(phoneNumberId, from, "Our menu is empty right now. Please try again in a little while.");
    return;
  }

   const toRow = ([key, g]) => ({
    id: `cat:${key}`,
    title: g.name.slice(0, 24),
    description: namesPreview(g.dishNames),
  });

  let rows;
  if (entries.length <= 10) {
    rows = entries.map(toRow);
  } else {
    const start = page * CATEGORIES_PER_PAGE;
    rows = entries.slice(start, start + CATEGORIES_PER_PAGE).map(toRow);
    if (start + CATEGORIES_PER_PAGE < entries.length) {
      rows.push({ id: `catpage:${page + 1}`, title: "More Categories" });
    }
  }

  await sendList(
    phoneNumberId,
    from,
    `Welcome to ${restaurantName}`.slice(0, 60),
    "Please choose a category to see our dishes.",
    "View Categories",
    rows
  );
}

async function sendCategoryProducts(db, phoneNumberId, from, restaurantId, categoryKey) {
  const catalogSnap = await db.ref(`restaurants/${restaurantId}/metaCatalog/catalogId`).once("value");
  const catalogId = catalogSnap.val();
  if (!catalogId) {
    await sendText(phoneNumberId, from, "Our menu is being set up. Please try again shortly.");
    return;
  }

  const groups = await loadMenuGroups(db, restaurantId);
  const group = groups[categoryKey];
  if (!group) {
    await sendText(phoneNumberId, from, "This category is not available right now.");
    await sendCategoryList(db, phoneNumberId, from, restaurantId);
    return;
  }

  // WhatsApp limit: ek message mein max 30 products
  const chunks = [];
  for (let i = 0; i < group.items.length; i += 30) chunks.push(group.items.slice(i, i + 30));

  for (let i = 0; i < chunks.length; i++) {
    const title = chunks.length > 1 ? `${group.name} (${i + 1}/${chunks.length})` : group.name;
    await sendProductList(
      phoneNumberId,
      from,
      catalogId,
      title.slice(0, 60),
      "Select the items you want and add them to your cart.",
      [{ title: group.name.slice(0, 24), product_items: chunks[i].map((id) => ({ product_retailer_id: id })) }]
    );
  }

  await sendButtons(
    phoneNumberId,
    from,
    "Done adding items? Open your cart and tap Place Order, or browse another category.",
    [{ id: "show_categories", title: "Other Categories" }]
  );
}
// Greeting + "View Menu" button
async function sendMenuGreeting(db, phoneNumberId, from, restaurantId) {
  const nameSnap = await db.ref(`restaurants/${restaurantId}/name`).once("value");
  const restaurantName = nameSnap.val() || "our restaurant";

  const groups = await loadMenuGroups(db, restaurantId);
  const thumbnail = Object.values(groups)[0]?.items?.[0];

  const res = await sendCatalogMessage(
    phoneNumberId,
    from,
    `Welcome to ${restaurantName}! 👋\nTap View catalog to browse our menu by category, add items to your cart, and place your order.`,
    thumbnail
  );

  if (res?.error) {
    await sendButtons(
      phoneNumberId,
      from,
      `Welcome to ${restaurantName}! 👋\nTap the button below to see our menu.`,
      [{ id: "view_menu", title: "View Menu" }]
    );
  }
}

// Categories ko WhatsApp ke limits ke hisaab se messages mein pack karo
// (ek message: max 10 sections aur max 30 products)
function buildMenuMessages(groups) {
  const messages = [];
  let current = [];
  let count = 0;
  const flush = () => {
    if (current.length) {
      messages.push(current);
      current = [];
      count = 0;
    }
  };

  for (const g of Object.values(groups)) {
    const items = [...g.items];
    let part = 1;
    while (items.length) {
      if (current.length >= 10 || count >= 30) flush();
      const take = items.splice(0, 30 - count);
      const title = part > 1 ? `${g.name} (cont.)` : g.name;
      current.push({
        title: title.slice(0, 24),
        product_items: take.map((id) => ({ product_retailer_id: id })),
      });
      count += take.length;
      part++;
    }
  }
  flush();
  return messages;
}

// "View Menu" dabane par poora menu category-wise bhejo
async function sendFullMenuProducts(db, phoneNumberId, from, restaurantId) {
  const catalogSnap = await db.ref(`restaurants/${restaurantId}/metaCatalog/catalogId`).once("value");
  const catalogId = catalogSnap.val();
  if (!catalogId) {
    await sendText(phoneNumberId, from, "Our menu is being set up. Please try again shortly.");
    return;
  }

  const groups = await loadMenuGroups(db, restaurantId);
  const messages = buildMenuMessages(groups);
  if (messages.length === 0) {
    await sendText(phoneNumberId, from, "Our menu is empty right now. Please try again in a little while.");
    return;
  }

  for (let i = 0; i < messages.length; i++) {
    const header = messages.length > 1 ? `Our Menu (${i + 1}/${messages.length})` : "Our Menu";
    await sendProductList(
      phoneNumberId,
      from,
      catalogId,
      header,
      "Select items, add them to your cart, then tap View Cart and Place Order.",
      messages[i]
    );
  }
}
const FALLBACK_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 ghante

async function sendFullMenu(db, phoneNumberId, from, restaurantId) {
  const fbSnap = await db.ref(`restaurants/${restaurantId}/whatsapp/fallbackMessage`).once("value");
  const fallbackMessage = fbSnap.val();

  if (fallbackMessage) {
    // Same banda baar-baar type kare to har baar reply na jaye
    const seenRef = db.ref(`whatsappFallbackSeen/${restaurantId}/${from}`);
    const lastSent = (await seenRef.once("value")).val() || 0;
    if (Date.now() - lastSent < FALLBACK_COOLDOWN_MS) return;

    // "||" se multiple messages alag karo, "\n" literal ko asli new line banao
    const parts = String(fallbackMessage)
      .split("||")
      .map((p) => p.replace(/\\n/g, "\n").trim())
      .filter(Boolean);

    for (const part of parts) {
      await sendText(phoneNumberId, from, part);
    }
    await seenRef.set(Date.now());
    return;
  }

  await sendMenuGreeting(db, phoneNumberId, from, restaurantId);
}

// ★ Customer ka saved delivery address check karo
async function getSavedAddress(db, restaurantId, phone) {
  const snap = await db.ref(`customerProfiles/${restaurantId}/${phone}/address`).once("value");
  return snap.val() || null;
}

// ★ Address save karo taaki agli baar poochna na pade
async function saveCustomerAddress(db, restaurantId, phone, address) {
  await db.ref(`customerProfiles/${restaurantId}/${phone}`).update({
    address,
    updatedAt: Date.now(),
  });
}

// ── Coupon logic ──
async function applyCoupon(db, restaurantId, code, subtotal) {
  const snap = await db.ref(`coupons/${restaurantId}`).once("value");
  const coupons = snap.val() || {};
  const match = Object.values(coupons).find(
    (c) => (c.code || "").toUpperCase() === code.trim().toUpperCase()
  );

  if (!match) return { error: "This coupon code is invalid." };
  if (!match.active) return { error: "This coupon is not active right now." };
  if (match.expiryDate && new Date(match.expiryDate).getTime() < Date.now()) {
    return { error: "This coupon has expired." };
  }
  if (match.minOrder && subtotal < Number(match.minOrder)) {
    return { error: `A minimum order of ₹${match.minOrder} is required for this coupon.` };
  }

  let discount = 0;
  if (match.discountType === "percent") {
    discount = (subtotal * Number(match.discountValue)) / 100;
    if (match.maxDiscount > 0) discount = Math.min(discount, Number(match.maxDiscount));
  } else {
    discount = Number(match.discountValue);
  }
  discount = Math.min(discount, subtotal);

  return { discount: Math.round(discount * 100) / 100, code: match.code };
}

async function hasActiveCoupon(db, restaurantId) {
  const snap = await db.ref(`coupons/${restaurantId}`).once("value");
  const coupons = snap.val() || {};
  const now = Date.now();
  return Object.values(coupons).some((c) => {
    if (!c.active) return false;
    if (c.expiryDate && new Date(c.expiryDate).getTime() < now) return false;
    return true;
  });
}



async function decrementStockForOrder(db, restaurantId, items) {
  const { getFirestore } = require("firebase-admin/firestore");
  const firestore = getFirestore();

  for (const item of items) {
    if (!item.dishId) continue;
    const qtyToDeduct = Number(item.qty) || 1;

    try {
      const menuRef = db.ref(`restaurants/${restaurantId}/menu/${item.dishId}`);
      const snap = await menuRef.once("value");
      if (snap.exists()) {
        const data = snap.val();
        if (data.quantity === undefined || data.quantity === null) continue;

        const currentUsed = Number(data.quantityUsed) || 0;
        const newUsed = currentUsed + qtyToDeduct;
        const remaining = Math.max(0, (Number(data.quantity) || 0) - newUsed);

        await menuRef.update({
          quantityUsed: newUsed,
          remainingQuantity: remaining,
          inStock: remaining > 0,
          outOfStock: remaining <= 0,
          updatedAt: Date.now(),
        });

        try {
          const fsSnap = await firestore
            .collection("menu")
            .where("restaurantId", "==", restaurantId)
            .where("__name__", "==", item.dishId)
            .get();
          if (!fsSnap.empty) {
            await fsSnap.docs[0].ref.update({
              quantityUsed: newUsed,
              remainingQuantity: remaining,
              inStock: remaining > 0,
              outOfStock: remaining <= 0,
              updatedAt: Date.now(),
            });
          }
        } catch (fsErr) {
          console.error(`Firestore stock update failed for ${item.dishId}:`, fsErr.message);
        }
      }
    } catch (e) {
      console.error(`Stock decrement failed for ${item.name}:`, e.message);
    }
  }
}

// dish ke taste profile ke hisaab se decide karo kaunse customization steps chahiye


const MID_FLOW_STATES = [
   "in_flow",
  "awaiting_coupon_code", "awaiting_table", "awaiting_address",
  "awaiting_order_type", "awaiting_payment_method", "awaiting_confirm",
  "awaiting_coupon_choice", "awaiting_customize_choice",
  "collecting_prefs", "awaiting_spice", "awaiting_salt",
  "awaiting_sweet", "awaiting_salad",
  "awaiting_note_gate", "collecting_notes", "awaiting_note_text",
];

async function handleIncomingMessage(db, razorpay, message, phoneNumberId, restaurantId) {
  const from = message.from;
  const sessionRef = db.ref(`whatsappSessions/${restaurantId}/${from}`);
  // ── Category browsing (session ki zaroorat nahi) ──
  if (message.type === "interactive" && message.interactive?.type === "list_reply") {
    const id = message.interactive.list_reply.id || "";
    if (id.startsWith("cat:")) {
      await sendCategoryProducts(db, phoneNumberId, from, restaurantId, id.slice(4));
      return;
    }
    if (id.startsWith("catpage:")) {
      await sendCategoryList(db, phoneNumberId, from, restaurantId, Number(id.split(":")[1]) || 0);
      return;
    }
  }
  if (
    message.type === "interactive" &&
    message.interactive?.type === "button_reply" &&
    ["view_menu", "show_categories"].includes(message.interactive.button_reply.id)
  ) {
    await sendFullMenuProducts(db, phoneNumberId, from, restaurantId);
    return;
  }
  if (message.type === "text") {
    const snap = await sessionRef.once("value");
    const session = snap.val();
    const isMidFlow = session && MID_FLOW_STATES.includes(session.state);

    if (!isMidFlow) {
      await sendFullMenu(db, phoneNumberId, from, restaurantId);
      return;
    }
  }

  // ══════════════════════════════════════════
  // 1) Customer ne cart order bheja
  // ══════════════════════════════════════════
  if (message.type === "order") {
    const order = message.order;
    const rawItems = order.product_items || [];

    let subtotal = 0;
    const lines = [];
    for (const it of rawItems) {
      const dishId = it.product_retailer_id.split("_").slice(1).join("_");
      const dishInfo = await getDishDetails(db, restaurantId, dishId);
      const qty = Number(it.quantity) || 0;
      const lineTotal = (Number(it.item_price) || 0) * qty;
      subtotal += lineTotal;

      lines.push({
        dishId, name: dishInfo.name, qty, price: it.item_price, lineTotal,
        prepTime: dishInfo.prepTime, image: dishInfo.image,
        dishTasteProfile: dishInfo.dishTasteProfile,
        saltLevelEnabled: dishInfo.saltLevelEnabled,
        sugarLevelEnabled: dishInfo.sugarLevelEnabled,
        saladConfig: dishInfo.saladConfig,
        spicePreference: "normal",
        saltPreference: "normal",
        sweetLevel: "normal",
        salad: { qty: 0, taste: "normal" },
        specialInstructions: "",
      });
    }

       const orderId = `wa_${Date.now()}`;

    await sessionRef.set({
      state: "awaiting_customize_choice",
      orderId, items: lines, subtotal, discount: 0,
      createdAt: Date.now(),
    });

    await sendText(phoneNumberId, from, billSummaryText(lines, subtotal, 0, null));
    await sendButtons(phoneNumberId, from, "Would you like to customize your order, or keep it standard (faster)?", [
      { id: "customize_quick", title: "Keep Standard" },
      { id: "customize_start", title: "Customize" },
    ]);
    return;
  }

  // ══════════════════════════════════════════
  // 2) WhatsApp Flow (nfm_reply) — button_reply se ALAG, apna independent check
  // ══════════════════════════════════════════
  if (message.type === "interactive" && message.interactive?.type === "nfm_reply") {
    const responseJson = JSON.parse(message.interactive.nfm_reply.response_json || "{}");
    const snap = await sessionRef.once("value");
    const session = snap.val();
    if (!session) return;

       if (responseJson.trigger === "confirm_order") {
      // ★ Delivery ho to address handle karo
      if (session.orderType === "delivery") {
        const flowAddress = (session.address || "").trim();

        if (flowAddress) {
          // flow mein naya address bhara hai -> save kar lo (agli baar ke liye)
          await saveCustomerAddress(db, restaurantId, from, flowAddress);
        } else {
          // flow mein khaali chhoda -> purana saved address lo
          const savedAddress = await getSavedAddress(db, restaurantId, from);

          if (savedAddress) {
            await sessionRef.update({ address: savedAddress });
            await sendText(phoneNumberId, from, `📍 Using your saved address:\n${savedAddress}`);
          } else {
            // saved bhi nahi hai -> chat mein maang lo
            await sessionRef.update({ state: "awaiting_address" });
            await sendText(phoneNumberId, from, "📍 Please type your full delivery address in a single message:");
            return;
          }
        }
      }

      await sessionRef.update({ state: "awaiting_confirm" });
      await sendConfirmStep(db, phoneNumberId, from, restaurantId, sessionRef);
    } else if (responseJson.trigger === "cancel_order") {
      await sessionRef.remove();
      await sendText(phoneNumberId, from, "❌ Your order has been cancelled. To start a new order, send a message and pick items from our menu.");
    }
    return;
  }

  // ══════════════════════════════════════════
  // 3) Button replies
  // ══════════════════════════════════════════
  if (message.type === "interactive" && message.interactive?.type === "button_reply") {
    const buttonId = message.interactive.button_reply.id;
    const snap = await sessionRef.once("value");
    const session = snap.val();
    if (!session) return;

       if (session.state === "awaiting_customize_choice") {
      if (buttonId === "customize_quick") {
        await sessionRef.update({ state: "collected" });
        await proceedToOrderTypeOrCoupon(db, phoneNumberId, from, restaurantId, sessionRef);
      } else if (buttonId === "customize_start") {
        await sessionRef.update({ state: "in_flow" });
        const flowToken = `${restaurantId}|${from}`;
        const billText = billSummaryText(session.items, session.subtotal, 0, null);
        await sendFlowMessage(
          phoneNumberId, from, flowToken,
          "Customize Your Order", billText,
          "DETAILS", { bill_summary: billText }
        );
      }
      return;
    }

    if (["awaiting_spice", "awaiting_salt", "awaiting_sweet", "awaiting_salad"].includes(session.state)) {
      await handlePrefGroupButton(db, phoneNumberId, from, restaurantId, sessionRef, session, buttonId);
      return;
    }

    if (session.state === "awaiting_note_gate") {
      if (buttonId === "note_gate_yes") {
        await sessionRef.update({ state: "collecting_notes", noteItemIdx: 0 });
        await askNextStep(db, phoneNumberId, from, restaurantId, sessionRef);
      } else {
        await sessionRef.update({ state: "collected" });
        await proceedToOrderTypeOrCoupon(db, phoneNumberId, from, restaurantId, sessionRef);
      }
      return;
    }

    if (buttonId === "coupon_no") {
      await sessionRef.update({ state: "awaiting_order_type" });
      await sendButtons(phoneNumberId, from, "How would you like your order?", [
        { id: "type_dinein", title: "Dine-in" },
        { id: "type_delivery", title: "Delivery" },
        { id: "type_takeaway", title: "Takeaway" },
      ]);
      return;
    }

    if (buttonId === "coupon_yes") {
      await sessionRef.update({ state: "awaiting_coupon_code" });
      await sendText(phoneNumberId, from, "Please type your coupon code:");
      return;
    }

    if (buttonId === "type_dinein") {
      await sessionRef.update({ state: "awaiting_table", orderType: "dine_in" });
      await sendText(phoneNumberId, from, "Please send your table number (type 'skip' if you don't know):");
      return;
    }
    if (buttonId === "type_delivery") {
      const savedAddress = await getSavedAddress(db, restaurantId, from);

      if (savedAddress) {
        await sessionRef.update({ state: "awaiting_confirm", orderType: "delivery", address: savedAddress });
        await sendText(
          phoneNumberId,
          from,
         `📍 Using your saved address:\n${savedAddress}`
        );
        await sendConfirmStep(db, phoneNumberId, from, restaurantId, sessionRef);
      } else {
        await sessionRef.update({ state: "awaiting_address", orderType: "delivery" });
        await sendText(phoneNumberId, from, "📍 Please type your full delivery address in a single message:");
      }
      return;
    }
    if (buttonId === "type_takeaway") {
      await sessionRef.update({ state: "awaiting_confirm", orderType: "takeaway" });
      await sendConfirmStep(db, phoneNumberId, from, restaurantId, sessionRef);
      return;
    }

    if (buttonId === "confirm_order") {
      await sessionRef.update({ state: "awaiting_payment_method" });
      await sendButtons(phoneNumberId, from, "How would you like to pay?", [
        { id: "pay_upi", title: "Pay via UPI" },
        { id: "pay_cod", title: "Cash on Delivery" },
      ]);
      return;
    }
    if (buttonId === "cancel_order") {
      await sessionRef.remove();
      await sendText(phoneNumberId, from, "❌ Your order has been cancelled. To start a new order, send a message and pick items from our menu.");
      return;
    }

    if (buttonId === "pay_upi" || buttonId === "pay_cod") {
      const paymentMethod = buttonId === "pay_upi" ? "online" : "cod";
      await finalizeOrder(db, razorpay, restaurantId, from, phoneNumberId, session, paymentMethod);
      return;
    }
  }

  // ══════════════════════════════════════════
  // 3) Free text (note text / coupon code / table / address)
  // ══════════════════════════════════════════
  if (message.type === "text") {
    const snap = await sessionRef.once("value");
    const session = snap.val();
    if (!session) return;

    if (session.state === "awaiting_note_text") {
      const note = message.text.body.trim();
      const items = [...session.items];
      const idx = session.noteItemIdx;
      items[idx] = { ...items[idx], specialInstructions: note.toLowerCase() === "skip" ? "" : note };
      await sessionRef.update({ items, noteItemIdx: idx + 1, state: "collecting_notes" });
      await askNextStep(db, phoneNumberId, from, restaurantId, sessionRef);
      return;
    }

    if (session.state === "awaiting_coupon_code") {
      const code = message.text.body.trim();
      if (code.toLowerCase() === "skip") {
        await sessionRef.update({ state: "awaiting_order_type" });
      } else {
        const result = await applyCoupon(db, restaurantId, code, session.subtotal);
        if (result.error) {
          await sendText(phoneNumberId, from, `❌ ${result.error}\nPlease try again or type 'skip'.`);
          return;
        }
        await sessionRef.update({ discount: result.discount, couponCode: result.code, state: "awaiting_order_type" });
        await sendText(
          phoneNumberId,
          from,
          billSummaryText(session.items, session.subtotal, result.discount, result.code)
        );
      }
      await sendButtons(phoneNumberId, from, "Order kaise chahiye?", [
        { id: "type_dinein", title: "Dine-in" },
        { id: "type_delivery", title: "Delivery" },
        { id: "type_takeaway", title: "Takeaway" },
      ]);
      return;
    }

    if (session.state === "awaiting_table") {
      const tableNumber = message.text.body.trim();
      await sessionRef.update({
        state: "awaiting_confirm",
        tableNumber: tableNumber.toLowerCase() === "skip" ? null : tableNumber,
      });
      await sendConfirmStep(db, phoneNumberId, from, restaurantId, sessionRef);
      return;
    }

    if (session.state === "awaiting_address") {
      const address = message.text.body.trim();
      await sessionRef.update({ state: "awaiting_confirm", address });
      await saveCustomerAddress(db, restaurantId, from, address);
      await sendConfirmStep(db, phoneNumberId, from, restaurantId, sessionRef);
      return;
    }
  }
}



// group ka jawaab poore group ke saare items pe ek saath apply karo


async function proceedToOrderTypeOrCoupon(db, phoneNumberId, from, restaurantId, sessionRef) {
  const snap = await sessionRef.once("value");
  const session = snap.val();

  await sendText(phoneNumberId, from, billSummaryText(session.items, session.subtotal, 0, null));

  const couponAvailable = await hasActiveCoupon(db, restaurantId);
  if (couponAvailable) {
    await sessionRef.update({ state: "awaiting_coupon_choice" });
    await sendButtons(phoneNumberId, from, "Do you have a coupon code?", [
      { id: "coupon_yes", title: "Apply Coupon" },
      { id: "coupon_no", title: "No Coupon" },
    ]);
  } else {
    await sessionRef.update({ state: "awaiting_order_type" });
    await sendButtons(phoneNumberId, from, "How would you like your order?", [
      { id: "type_dinein", title: "Dine-in" },
      { id: "type_delivery", title: "Delivery" },
      { id: "type_takeaway", title: "Takeaway" },
    ]);
  }
}

async function sendConfirmStep(db, phoneNumberId, from, restaurantId, sessionRef) {
  const snap = await sessionRef.once("value");
  const session = snap.val();
  await sendText(
    phoneNumberId,
    from,
    billSummaryText(session.items, session.subtotal, session.discount || 0, session.couponCode)
  );
  await sendButtons(phoneNumberId, from, "Would you like to confirm your order?", [
    { id: "confirm_order", title: "Confirm Order" },
    { id: "cancel_order", title: "Cancel Order" },
  ]);
}

async function finalizeOrder(db, razorpay, restaurantId, from, phoneNumberId, session, paymentMethod) {
  const orderId = session.orderId;
  const total = session.subtotal - (session.discount || 0);

  const orderItems = session.items.map((it) => ({
    dishId: it.dishId,
    name: it.name,
    qty: it.qty,
    price: it.price,
    prepTime: it.prepTime || 15,
    image: it.image || "",
    dishTasteProfile: it.dishTasteProfile || "normal",
    spicePreference: it.spicePreference || "normal",
    saltPreference: it.saltPreference || "normal",
    sweetLevel: it.sweetLevel || "normal",
    salad: it.salad || { qty: 0, taste: "normal" },
    specialInstructions: it.specialInstructions || "",
  }));

  const orderData = {
    restaurantId,
    customerPhone: from,
    items: orderItems,
    subtotal: session.subtotal,
    discount: session.discount || 0,
    couponCode: session.couponCode || null,
    total,
        customerNote: session.note || null,
    orderType: session.orderType,
    tableNumber: session.tableNumber || null,
    address: session.address || null,
    paymentMethod,
    status: paymentMethod === "cod" ? "confirmed" : "awaiting_payment",
    paymentStatus: paymentMethod === "cod" ? "pending_cod" : "pending",
    source: "whatsapp",
    createdAt: Date.now(),
  };

  await db.ref(`whatsappOrders/${restaurantId}/${orderId}`).set(orderData);
  await db.ref(`orders/${restaurantId}/${orderId}`).set(orderData);
  console.log(`✅ Order written to orders/${restaurantId}/${orderId}`);

  await decrementStockForOrder(db, restaurantId, orderItems);

  await sessionRef_remove(db, restaurantId, from);

  const maxPrepTime = orderItems.length > 0
    ? Math.max(...orderItems.map((i) => i.prepTime || 15))
    : 15;
  const readyLine = `\n⏱️ Your order will be ready in about ${maxPrepTime} minutes.`;

  if (paymentMethod === "cod") {
    await sendText(
      phoneNumberId,
      from,
      `✅ Your order is confirmed!\nOrder ID: ${orderId}\nPayment: Cash on Delivery.${readyLine}`
    );
    return;
  }

  // ★ NEW: Razorpay QR ki jagah restaurant ki apni UPI ID se QR
  const restSnap = await db.ref(`restaurants/${restaurantId}`).once("value");
  const restData = restSnap.val() || {};
  const upiId = restData.payment?.upiId;
  const restaurantName = restData.name || "Restaurant";

  if (!upiId) {
    await sendText(
      phoneNumberId,
      from,
      `❌ UPI payment is not set up yet. Please choose Cash on Delivery or contact the restaurant.`
    );
    return;
  }

  const upiUrl = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(restaurantName)}&am=${total.toFixed(2)}&cu=INR&tn=${encodeURIComponent("Order " + orderId)}`;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(upiUrl)}`;

  await sendImage(
    phoneNumberId,
    from,
    qrImageUrl,
    `💳 Scan the QR code to pay ₹${total.toFixed(2)}\nOrder ID: ${orderId}${readyLine}`
  );
}

async function sessionRef_remove(db, restaurantId, from) {
  await db.ref(`whatsappSessions/${restaurantId}/${from}`).remove();
}

module.exports = { handleIncomingMessage };