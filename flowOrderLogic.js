// flowOrderLogic.js
const { billSummaryText } = require("./billUtils");

function detailsScreenData(session) {
  return {
    bill_summary: billSummaryText(session.items, session.subtotal, session.discount || 0, session.couponCode),
  };
}

async function handleFlowDataExchange(db, restaurantId, from, decryptedBody) {
  const sessionRef = db.ref(`whatsappSessions/${restaurantId}/${from}`);
  const snap = await sessionRef.once("value");
  const session = snap.val();
  const { trigger } = decryptedBody.data || {};

  if (decryptedBody.action === "INIT") {
    return { screen: "DETAILS", data: detailsScreenData(session) };
  }

  if (trigger === "details_next") {
    const { note, order_type, table_number, address } = decryptedBody.data;

    // ★ Delivery mein address khaali ho to saved address uthao
    let finalAddress = (address || "").trim() || null;
    if (order_type === "delivery" && !finalAddress) {
      const addrSnap = await db.ref(`customerProfiles/${restaurantId}/${from}/address`).once("value");
      finalAddress = addrSnap.val() || null;
    }

    await sessionRef.update({
      note: note || "",
      orderType: order_type,
      tableNumber: table_number || null,
      address: order_type === "delivery" ? finalAddress : null,
    });
    const updatedSnap = await sessionRef.once("value");
    const updated = updatedSnap.val();
    const summary =
      billSummaryText(updated.items, updated.subtotal, updated.discount || 0, updated.couponCode) +
      (updated.note ? `\n📝 ${updated.note}` : "") +
      (updated.address ? `\n📍 ${updated.address}` : "");
    return { screen: "CONFIRM", data: { final_summary: summary } };
  }

  return { screen: "CONFIRM", data: { final_summary: "Kuch galat ho gaya, dubara try karo." } };
}

module.exports = { handleFlowDataExchange };