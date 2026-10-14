// catalogVariants.js
const MAX_VARIANT_SLOTS = 5;

function variantTotal(dish, v) {
  const t = v.totalPrice;
  if (t !== undefined && t !== null && Number.isFinite(Number(t))) return Number(t);
  return (Number(dish.price) || 0) + (Number(v.extraPrice) || 0);
}

// entries[0] = base, entries[i+1] = priceVariants[i]
function buildCatalogEntries(dish) {
  const name = dish.name || "Item";
  const variants = Array.isArray(dish.priceVariants) ? dish.priceVariants : [];
  const hasHalf = variants.some((v) => /half/i.test(v.name || ""));
  const baseLabel = hasHalf ? "Full" : "";

  const entries = [{
    idSuffix: "",
    name: baseLabel ? `${name} (${baseLabel})` : name,
    price: Number(dish.price) || 0,
    portion: baseLabel,
  }];
  variants.forEach((v, i) => entries.push({
    idSuffix: `__v${i}`,
    name: `${name} (${v.name})`,
    price: variantTotal(dish, v),
    portion: v.name,
  }));
  return entries;
}

module.exports = { buildCatalogEntries, MAX_VARIANT_SLOTS };