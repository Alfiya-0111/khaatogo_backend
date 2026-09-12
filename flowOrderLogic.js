// flowOrderLogic.js
// ★ NEW — jab customer ne catalog se cart bheja, tab yahan se Flow shuru hota
// hai. Session structure whatsappOrderHandler.js jaisa hi hai (Realtime DB
// mein whatsappSessions/{restaurantId}/{from}), sirf state naam alag hain.
// ★ Field names purane system se match karte hain: spicePreference,
// saltPreference, sweetLevel, specialInstructions — taaki finalizeOrder()
// aur admin/KDS panel bina kisi change ke inhe padh sakein.
const { billSummaryText } = require("./whatsappOrderHandler");

function needsCustomization(item) {
  return item.dishTasteProfile === "spicy" || (item.dishTasteProfile === "sweet" && item.sugarLevelEnabled);
}

// Flow ke pehle screen ka initial data — cart submit hote hi ye call hota hai
async function buildInitialScreenData(session) {
  const idx = session.items.findIndex((it, i) => i >= (session.flowItemIdx || 0) && needsCustomization(it));
  if (idx === -1) {
    return { screen: "ORDER_DETAILS", data: orderDetailsData(session) };
  }
  return { screen: "ITEM_CUSTOMIZE", data: itemScreenData(session, idx) };
}

function itemScreenData(session, idx) {
  const item = session.items[idx];
  const soFar = session.items.slice(0, idx).reduce((s, i) => s + i.lineTotal, 0);
  return {
    item_name: `${item.name} (${idx + 1}/${session.items.length})`,
    show_spice: item.dishTasteProfile === "spicy",
    show_salt: item.dishTasteProfile === "spicy" && !!item.saltLevelEnabled,
    show_sweet: item.dishTasteProfile === "sweet" && !!item.sugarLevelEnabled,
    running_total: `Ab tak: ₹${soFar.toFixed(2)} (Subtotal: ₹${session.subtotal.toFixed(2)})`,
  };
}

function orderDetailsData(session) {
  return { bill_summary: billSummaryText(session.items, session.subtotal, 0, null) };
}

// Meta se aaya har data_exchange call yahan handle hota hai
async function handleFlowDataExchange(db, restaurantId, from, decryptedBody) {
  const sessionRef = db.ref(`whatsappSessions/${restaurantId}/${from}`);
  const snap = await sessionRef.once("value");
  const session = snap.val();
  const { trigger } = decryptedBody.data || {};

  // ── init: flow open hote hi Meta pehla data_exchange bhejta hai ──
  if (decryptedBody.action === "INIT") {
    await sessionRef.update({ flowItemIdx: 0 });
    const next = await buildInitialScreenData({ ...session, flowItemIdx: 0 });
    return next;
  }

  if (trigger === "item_next") {
    const idx = session.flowItemIdx || 0;
    const items = [...session.items];
    items[idx] = {
      ...items[idx],
      spicePreference: decryptedBody.data.spice || "normal",
      saltPreference: decryptedBody.data.salt || "normal",
      sweetLevel: decryptedBody.data.sweet || "normal",
      specialInstructions: decryptedBody.data.note || "",
    };
    const nextIdx = idx + 1;
    await sessionRef.update({ items, flowItemIdx: nextIdx });
    return buildInitialScreenData({ ...session, items, flowItemIdx: nextIdx });
  }

  if (trigger === "order_details_next") {
    const { order_type, table_number, address } = decryptedBody.data;
    await sessionRef.update({ orderType: order_type, tableNumber: table_number || null, address: address || null });
    const updatedSnap = await sessionRef.once("value");
    return { screen: "CONFIRM", data: { final_summary: orderDetailsData(updatedSnap.val()).bill_summary } };
  }

  // trigger === "confirm_order" Meta khud "complete" action se bhejta hai,
  // wo webhook/whatsapp route pe nfm_reply message ke roop mein aata hai —
  // yahan data_exchange endpoint pe nahi. Us case ka code index.js mein hai.
  return { screen: "CONFIRM", data: { final_summary: "Kuch galat ho gaya, dubara try karo." } };
}

module.exports = { handleFlowDataExchange, needsCustomization };