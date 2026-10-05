// categoryUtils.js
// Dish ki ek category ka naam nikalo (collection ek hi label par banta hai)
function dishCategoryName(dish, categoriesData) {
  if (Array.isArray(dish.categoryIds) && dish.categoryIds.length > 0) {
    for (const cid of dish.categoryIds) {
      const name = categoriesData?.[cid]?.name;
      if (name) return name;
    }
  }
  return dish.category || "Other";
}

module.exports = { dishCategoryName };