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
    await sessionRef.update({
      note: note || "",
      orderType: order_type,
      tableNumber: table_number || null,
      address: address || null,
    });
    const updatedSnap = await sessionRef.once("value");
    const updated = updatedSnap.val();
    const summary =
      billSummaryText(updated.items, updated.subtotal, updated.discount || 0, updated.couponCode) +
      (updated.note ? `\n📝 ${updated.note}` : "");
    return { screen: "CONFIRM", data: { final_summary: summary } };
  }

  return { screen: "CONFIRM", data: { final_summary: "Kuch galat ho gaya, dubara try karo." } };
}

module.exports = { handleFlowDataExchange };