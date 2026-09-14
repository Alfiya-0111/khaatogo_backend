// billUtils.js
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
  if (discount > 0) text += `\n🏷️ Coupon (${couponCode}): −₹${discount.toFixed(2)}`;
  text += `\n\n*Total: ₹${(subtotal - discount).toFixed(2)}*`;
  return text;
}
module.exports = { billSummaryText };