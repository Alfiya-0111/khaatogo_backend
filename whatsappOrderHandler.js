// whatsappOrderHandler.js
const admin = require("firebase-admin");
const { sendText, sendButtons, sendImage, sendProductList } = require("./whatsappOrderBot");
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

async function sendFullMenu(db, phoneNumberId, from, restaurantId) {
  const [menuSnap, catalogSnap, catSnap] = await Promise.all([
    db.ref(`restaurants/${restaurantId}/menu`).once("value"),
    db.ref(`restaurants/${restaurantId}/metaCatalog/catalogId`).once("value"),
    db.ref(`restaurants/${restaurantId}/categories`).once("value"),
  ]);

  const menu = menuSnap.val() || {};
  const catalogId = catalogSnap.val();
  const categoriesData = catSnap.val() || {};

  if (!catalogId) {
    await sendText(phoneNumberId, from, "Menu abhi setup ho raha hai, thodi der baad try karo 🙏");
    return;
  }

  const grouped = {};
  for (const [dishId, dish] of Object.entries(menu)) {
    if (dish.inStock === false || dish.remainingQuantity === 0) continue;

    let catNames = [];
    if (Array.isArray(dish.categoryIds) && dish.categoryIds.length > 0) {
      dish.categoryIds.forEach((cid) => {
        const catName = categoriesData[cid]?.name;
        if (catName) catNames.push(catName);
      });
    } else if (dish.category) {
      catNames.push(dish.category);
    }
    if (catNames.length === 0) catNames.push("Other");

    catNames.forEach((cat) => {
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push({ product_retailer_id: `${restaurantId}_${dishId}` });
    });
  }

  const sections = Object.entries(grouped)
    .slice(0, 30)
    .map(([title, items]) => ({ title: title.slice(0, 24), product_items: items.slice(0, 30) }));

  if (sections.length === 0) {
    await sendText(phoneNumberId, from, "Abhi menu khaali hai, thodi der baad try karo 🙏");
    return;
  }

  await sendProductList(
    phoneNumberId,
    from,
    catalogId,
    "Hamara Menu 🍽️",
    "Neeche se items select karo aur cart mein add karke order karo:",
    sections
  );
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

  if (!match) return { error: "Coupon code galat hai ya exist nahi karta." };
  if (!match.active) return { error: "Ye coupon abhi active nahi hai." };
  if (match.expiryDate && new Date(match.expiryDate).getTime() < Date.now()) {
    return { error: "Ye coupon expire ho chuka hai." };
  }
  if (match.minOrder && subtotal < Number(match.minOrder)) {
    return { error: `Is coupon ke liye minimum order ₹${match.minOrder} hona chahiye.` };
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

function billSummaryText(lines, subtotal, discount, couponCode) {
  const itemsText = lines.map((l) => {
    let line = `${l.qty} x ${l.name} = ₹${l.lineTotal.toFixed(2)}`;
    const tags = [];
    if (l.dishTasteProfile !== "sweet" && l.spicePreference && l.spicePreference !== "normal") tags.push(`🌶️ ${l.spicePreference}`);
    if (l.dishTasteProfile === "sweet" && l.sweetLevel && l.sweetLevel !== "normal") tags.push(`🍯 ${l.sweetLevel}`);
    if (l.saltPreference && l.saltPreference !== "normal") tags.push(`🧂 ${l.saltPreference}`);
    if (l.salad?.qty > 0) tags.push(`🥗 Salad`);
    if (tags.length) line += `\n   (${tags.join(", ")})`;
    if (l.specialInstructions) line += `\n   📝 ${l.specialInstructions}`;
    return line;
  }).join("\n");
  let text = `🧾 Aapka order:\n${itemsText}\n\nSubtotal: ₹${subtotal.toFixed(2)}`;
  if (discount > 0) {
    text += `\n🏷️ Coupon (${couponCode}): −₹${discount.toFixed(2)}`;
  }
  const total = subtotal - discount;
  text += `\n\n*Total: ₹${total.toFixed(2)}*`;
  return text;
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
function getCustomizationSteps(item) {
  const steps = [];
  if (item.dishTasteProfile === "spicy") {
    steps.push("spice");
    if (item.saltLevelEnabled) steps.push("salt");
    if (item.saladConfig?.enabled) steps.push("salad");
  } else if (item.dishTasteProfile === "sweet") {
    if (item.sugarLevelEnabled) steps.push("sweet");
  }
  steps.push("note");
  return steps;
}

// same customization-requirement wale items ek group mein daalo,
// taaki spice/salt/sweet sirf EK BAAR poocha jaye poore group ke liye
function buildPreferenceGroups(items) {
  const groups = [];
  const keyToGroupIdx = {};

  items.forEach((item, idx) => {
    const allSteps = getCustomizationSteps(item);
    const prefSteps = allSteps.filter((s) => s !== "note");
    if (prefSteps.length === 0) return;

    const key = `${item.dishTasteProfile}|${prefSteps.join(",")}`;
    if (keyToGroupIdx[key] === undefined) {
      keyToGroupIdx[key] = groups.length;
      groups.push({ key, steps: prefSteps, itemIndices: [], names: [] });
    }
    const g = groups[keyToGroupIdx[key]];
    g.itemIndices.push(idx);
    g.names.push(item.name);
  });

  return groups;
}

const MID_FLOW_STATES = [
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
    const prefGroups = buildPreferenceGroups(lines);

    await sessionRef.set({
      state: "awaiting_customize_choice",
      orderId,
      items: lines,
      subtotal,
      discount: 0,
      createdAt: Date.now(),
      prefGroups,
      prefGroupIdx: 0,
      prefStepIdx: 0,
      noteItemIdx: 0,
    });

    await sendText(phoneNumberId, from, billSummaryText(lines, subtotal, 0, null));
    await sendButtons(phoneNumberId, from, "Order customize karni hai ya sab normal (jaldi) rakhein?", [
      { id: "customize_quick", title: "Sab Normal" },
      { id: "customize_start", title: "Customize Karo" },
    ]);
    return;
  }

  // ══════════════════════════════════════════
  // 2) Button replies
  // ══════════════════════════════════════════
  if (message.type === "interactive" && message.interactive?.type === "button_reply") {
    const buttonId = message.interactive.button_reply.id;
    const snap = await sessionRef.once("value");
    const session = snap.val();
    if (!session) return;

    if (session.state === "awaiting_customize_choice") {
      if (buttonId === "customize_quick") {
        await sessionRef.update({ state: "awaiting_note_gate" });
        await sendButtons(phoneNumberId, from, "📝 Kisi item mein special instruction chahiye? (jaise: no onion, less oil)", [
          { id: "note_gate_yes", title: "Haan, batani hai" },
          { id: "note_gate_no", title: "Nahi, skip" },
        ]);
      } else if (buttonId === "customize_start") {
        await sessionRef.update({ state: "collecting_prefs" });
        await askNextStep(db, phoneNumberId, from, restaurantId, sessionRef);
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
      await sendButtons(phoneNumberId, from, "Order kaise chahiye?", [
        { id: "type_dinein", title: "Dine-in" },
        { id: "type_delivery", title: "Delivery" },
        { id: "type_takeaway", title: "Takeaway" },
      ]);
      return;
    }

    if (buttonId === "coupon_yes") {
      await sessionRef.update({ state: "awaiting_coupon_code" });
      await sendText(phoneNumberId, from, "Coupon code type karke bhejo:");
      return;
    }

    if (buttonId === "type_dinein") {
      await sessionRef.update({ state: "awaiting_table", orderType: "dine_in" });
      await sendText(phoneNumberId, from, "Table number bhejo (agar pata nahi to 'skip' likho):");
      return;
    }
    if (buttonId === "type_delivery") {
      const savedAddress = await getSavedAddress(db, restaurantId, from);

      if (savedAddress) {
        await sessionRef.update({ state: "awaiting_confirm", orderType: "delivery", address: savedAddress });
        await sendText(
          phoneNumberId,
          from,
          `📍 Aapka saved address use kiya ja raha hai:\n${savedAddress}`
        );
        await sendConfirmStep(db, phoneNumberId, from, restaurantId, sessionRef);
      } else {
        await sessionRef.update({ state: "awaiting_address", orderType: "delivery" });
        await sendText(phoneNumberId, from, "📍 Delivery address type karke bhejo (pura address ek message mein):");
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
      await sendButtons(phoneNumberId, from, "Payment kaise karenge?", [
        { id: "pay_upi", title: "Pay via UPI" },
        { id: "pay_cod", title: "Cash on Delivery" },
      ]);
      return;
    }
    if (buttonId === "cancel_order") {
      await sessionRef.remove();
      await sendText(phoneNumberId, from, "❌ Order cancel kar diya gaya. Naya order shuru karne ke liye phir se catalog se items bhejo.");
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
          await sendText(phoneNumberId, from, `❌ ${result.error}\nDubara try karo ya 'skip' likho.`);
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

// pref-groups aur notes dono handle karta hai
async function askNextStep(db, phoneNumberId, from, restaurantId, sessionRef) {
  const snap = await sessionRef.once("value");
  const session = snap.val();
  if (!session) return;

  if (session.state === "collecting_prefs") {
    const { prefGroups } = session;
    let groupIdx = session.prefGroupIdx;
    let stepIdx = session.prefStepIdx;

    if (groupIdx >= prefGroups.length) {
      await sessionRef.update({ state: "awaiting_note_gate" });
      await sendButtons(phoneNumberId, from, "📝 Kisi item mein special instruction chahiye? (jaise: no onion, less oil)", [
        { id: "note_gate_yes", title: "Haan, batani hai" },
        { id: "note_gate_no", title: "Nahi, skip" },
      ]);
      return;
    }

    const group = prefGroups[groupIdx];
    if (stepIdx >= group.steps.length) {
      groupIdx += 1;
      stepIdx = 0;
      await sessionRef.update({ prefGroupIdx: groupIdx, prefStepIdx: stepIdx });
      return askNextStep(db, phoneNumberId, from, restaurantId, sessionRef);
    }

    const step = group.steps[stepIdx];
    const label = group.itemIndices.length > 1
      ? `*${group.names.join(", ")}* (${group.itemIndices.length} items)`
      : `*${group.names[0]}*`;

    if (step === "spice") {
      await sessionRef.update({ state: "awaiting_spice" });
      await sendButtons(phoneNumberId, from, `${label}\n🌶️ Spice level kitna chahiye?`, [
        { id: "spice_normal", title: "Normal" },
        { id: "spice_medium", title: "Medium" },
        { id: "spice_spicy", title: "Spicy" },
      ]);
      return;
    }
    if (step === "salt") {
      await sessionRef.update({ state: "awaiting_salt" });
      await sendButtons(phoneNumberId, from, `${label}\n🧂 Salt kitna chahiye?`, [
        { id: "salt_normal", title: "Normal" },
        { id: "salt_medium", title: "Medium" },
        { id: "salt_extra", title: "Extra" },
      ]);
      return;
    }
    if (step === "sweet") {
      await sessionRef.update({ state: "awaiting_sweet" });
      await sendButtons(phoneNumberId, from, `${label}\n🍯 Sweetness kitni chahiye?`, [
        { id: "sweet_less", title: "Less" },
        { id: "sweet_normal", title: "Normal" },
        { id: "sweet_extra", title: "Extra" },
      ]);
      return;
    }
    if (step === "salad") {
      await sessionRef.update({ state: "awaiting_salad" });
      await sendButtons(phoneNumberId, from, `${label}\n🥗 Salad add karna hai?`, [
        { id: "salad_yes", title: "Yes" },
        { id: "salad_no", title: "No" },
      ]);
      return;
    }
  }

  if (session.state === "collecting_notes") {
    const { items } = session;
    const idx = session.noteItemIdx;
    if (idx >= items.length) {
      await sessionRef.update({ state: "collected" });
      await proceedToOrderTypeOrCoupon(db, phoneNumberId, from, restaurantId, sessionRef);
      return;
    }
    await sessionRef.update({ state: "awaiting_note_text" });
    await sendText(phoneNumberId, from, `📝 *${items[idx].name}* ke liye special instruction? (nahi chahiye to 'skip' likho)`);
    return;
  }
}

// group ka jawaab poore group ke saare items pe ek saath apply karo
async function handlePrefGroupButton(db, phoneNumberId, from, restaurantId, sessionRef, session, buttonId) {
  const items = [...session.items];
  const group = session.prefGroups[session.prefGroupIdx];
  let value = null;

  if (session.state === "awaiting_spice") value = { field: "spicePreference", val: buttonId.replace("spice_", "") };
  else if (session.state === "awaiting_salt") value = { field: "saltPreference", val: buttonId.replace("salt_", "") };
  else if (session.state === "awaiting_sweet") value = { field: "sweetLevel", val: buttonId.replace("sweet_", "") };
  else if (session.state === "awaiting_salad") value = { field: "salad", val: { qty: buttonId === "salad_yes" ? 1 : 0, taste: "normal" } };

  if (value) {
    group.itemIndices.forEach((idx) => {
      items[idx] = { ...items[idx], [value.field]: value.val };
    });
  }

  await sessionRef.update({ items, prefStepIdx: session.prefStepIdx + 1, state: "collecting_prefs" });
  await askNextStep(db, phoneNumberId, from, restaurantId, sessionRef);
}

async function proceedToOrderTypeOrCoupon(db, phoneNumberId, from, restaurantId, sessionRef) {
  const snap = await sessionRef.once("value");
  const session = snap.val();

  await sendText(phoneNumberId, from, billSummaryText(session.items, session.subtotal, 0, null));

  const couponAvailable = await hasActiveCoupon(db, restaurantId);
  if (couponAvailable) {
    await sessionRef.update({ state: "awaiting_coupon_choice" });
    await sendButtons(phoneNumberId, from, "Kya koi coupon apply karna hai?", [
      { id: "coupon_yes", title: "Apply Coupon" },
      { id: "coupon_no", title: "No Coupon" },
    ]);
  } else {
    await sessionRef.update({ state: "awaiting_order_type" });
    await sendButtons(phoneNumberId, from, "Order kaise chahiye?", [
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
  await sendButtons(phoneNumberId, from, "Order confirm karein?", [
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
  const readyLine = `\n⏱️ Aapka order ~${maxPrepTime} minute mein ready ho jayega.`;

  if (paymentMethod === "cod") {
    await sendText(
      phoneNumberId,
      from,
      `✅ Order confirm ho gaya!\nOrder ID: ${orderId}\nPayment cash pe.${readyLine}`
    );
    return;
  }

  const qr = await razorpay.qrCode.create({
    type: "upi_qr",
    name: `Khaatogo Order ${orderId}`,
    usage: "single_use",
    fixed_amount: true,
    payment_amount: Math.round(total * 100),
    description: `Khaatogo Order ${orderId}`,
    notes: { restaurantId, orderId, source: "whatsapp" },
  });

  await db.ref(`whatsappOrders/${restaurantId}/${orderId}`).update({ razorpayQrCodeId: qr.id });
  await db.ref(`orders/${restaurantId}/${orderId}`).update({ razorpayQrCodeId: qr.id });

  await sendImage(
    phoneNumberId,
    from,
    qr.image_url,
    `💳 Scan karke ₹${total.toFixed(2)} pay karo\nOrder ID: ${orderId}${readyLine}`
  );
}

async function sessionRef_remove(db, restaurantId, from) {
  await db.ref(`whatsappSessions/${restaurantId}/${from}`).remove();
}

module.exports = { handleIncomingMessage };