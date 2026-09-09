// whatsappOrderHandler.js
const { sendText, sendButtons } = require("./whatsappOrderBot");

async function getDishDetails(db, restaurantId, dishId) {
  const snap = await db.ref(`restaurants/${restaurantId}/menu/${dishId}`).once("value");
  const dish = snap.val() || {};
  return {
    name: dish.name || "Item",
    prepTime: Number(dish.prepTime) || 15, // ★ NEW — AddItem mein set kiya hua prep time
  };
}

// ── Coupon validate + discount calculate karo ──
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

// ★ NEW — restaurant ka koi active, non-expired coupon hai ya nahi check karo
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
  const itemsText = lines.map((l) => `${l.qty} x ${l.name} = ₹${l.lineTotal.toFixed(2)}`).join("\n"); // ★ CHANGED: l.quantity → l.qty
  let text = `🧾 Aapka order:\n${itemsText}\n\nSubtotal: ₹${subtotal.toFixed(2)}`;
  if (discount > 0) {
    text += `\n🏷️ Coupon (${couponCode}): −₹${discount.toFixed(2)}`;
  }
  const total = subtotal - discount;
  text += `\n\n*Total: ₹${total.toFixed(2)}*`;
  return text;
}

async function handleIncomingMessage(db, razorpay, message, phoneNumberId, restaurantId) {
  const from = message.from;
  const sessionRef = db.ref(`whatsappSessions/${restaurantId}/${from}`);

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
      const { name, prepTime } = await getDishDetails(db, restaurantId, dishId); // ★ CHANGED
      const qty = Number(it.quantity) || 0; // ★ CHANGED
      const lineTotal = (Number(it.item_price) || 0) * qty;
      subtotal += lineTotal;
      lines.push({ dishId, name, qty, price: it.item_price, lineTotal, prepTime }); // ★ CHANGED: quantity→qty, +prepTime
    }

    const orderId = `wa_${Date.now()}`;
    await sessionRef.set({
      state: "processing",
      orderId,
      items: lines,
      subtotal,
      discount: 0,
      createdAt: Date.now(),
    });

    await sendText(phoneNumberId, from, billSummaryText(lines, subtotal, 0, null));

    // ★ CHANGED — sirf tab coupon poocho jab restaurant ka koi active coupon ho
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
      await sessionRef.update({ state: "awaiting_address", orderType: "delivery" });
      await sendText(phoneNumberId, from, "📍 Delivery address type karke bhejo (pura address ek message mein):");
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
  // 3) Free text (coupon code / table / address)
  // ══════════════════════════════════════════
  if (message.type === "text") {
    const snap = await sessionRef.once("value");
    const session = snap.val();
    if (!session) return;

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
      await sessionRef.update({ state: "awaiting_confirm", address: message.text.body });
      await sendConfirmStep(db, phoneNumberId, from, restaurantId, sessionRef);
      return;
    }
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

  // ★ NEW — admin dashboard (Ordercard.js) ke items format se match karne ke liye
  const orderItems = session.items.map((it) => ({
    dishId: it.dishId,
    name: it.name,
    qty: it.qty,
    price: it.price,
    prepTime: it.prepTime || 15,
  }));

  const orderData = {
    restaurantId,
    customerPhone: from,
    items: orderItems, // ★ CHANGED — qty field ke saath
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
  await db.ref(`orders/${restaurantId}/${orderId}`).set(orderData); // ★ Admin dashboard (KOT + Bill dono) isi se order dekhega

  await sessionRef_remove(db, restaurantId, from);

  // ★ CHANGED — track link ki jagah "X minute mein ready hoga" (AddItem ke prepTime se)
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

  // ── Online payment: Razorpay payment link banao ──
  const link = await razorpay.paymentLink.create({
    amount: Math.round(total * 100),
    currency: "INR",
    accept_partial: false,
    description: `Khaatogo Order ${orderId}`,
    customer: { contact: from },
    notify: { sms: false, email: false },
    notes: { restaurantId, orderId, source: "whatsapp" },
  });

  await db.ref(`whatsappOrders/${restaurantId}/${orderId}`).update({ razorpayPaymentLinkId: link.id });
  await db.ref(`orders/${restaurantId}/${orderId}`).update({ razorpayPaymentLinkId: link.id });

  await sendText(
    phoneNumberId,
    from,
    `💳 Payment karo:\n${link.short_url}\n\nOrder ID: ${orderId}${readyLine}`
  );
}

async function sessionRef_remove(db, restaurantId, from) {
  await db.ref(`whatsappSessions/${restaurantId}/${from}`).remove();
}

module.exports = { handleIncomingMessage };