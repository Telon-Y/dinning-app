// 食材价格一览：哪些食材有参考价、哪些还是「待补价」，以及它在冰箱里的存量。
// 纯函数，界面只负责画。

import { hasStock } from "./expiry.js?v=4d701ad";

export function buildPriceBook(data, { query = "", filter = "all", limit = 40 } = {}) {
  const foods = (data && data.foods) || [];
  const batches = (data && data.inventoryBatches) || [];
  // 标过「库存·没花钱」的食材：本来就没有价格可言，不算「待补价」
  const noMoneyIds = new Set(((data && data.purchases) || []).filter((p) => p.storeId === "stock").map((p) => p.foodId));

  const stockByFood = new Map();
  for (const b of batches) {
    // 吃完的批次不算「冰箱里有」：否则「只看有库存的」会把已经吃完的食材列出来
    if (b.quantityState !== "exact" || !hasStock(b)) continue;
    const cur = stockByFood.get(b.foodId) || { qty: 0, unit: b.unit };
    cur.qty += Number(b.quantity) || 0;
    stockByFood.set(b.foodId, cur);
  }

  const all = foods.map((food) => {
    const packs = food.packSizes || [];
    const pack = packs.find((p) => p.pricePence != null) || packs[0] || null;
    const priced = !!(pack && pack.pricePence != null);
    const stock = stockByFood.get(food.id) || null;
    const unitPricePence = priced && pack.size > 0 ? pack.pricePence / pack.size : null;
    return { food, pack, priced, stock, unitPricePence, noMoney: !priced && noMoneyIds.has(food.id) };
  });

  const q = String(query || "").trim().toLowerCase();
  const matched = all.filter((r) => {
    if (filter === "noprice" && (r.priced || r.noMoney)) return false;
    if (filter === "priced" && !r.priced) return false;
    if (filter === "instock" && !r.stock) return false;
    if (!q) return true;
    return (
      r.food.name.toLowerCase().includes(q) ||
      (r.food.aliases || []).some((a) => String(a).toLowerCase().includes(q))
    );
  });

  // 待补价的排前面（那才是要动手的），其余按名字
  const sorted = [...matched].sort(
    (a, b) => Number(a.priced) - Number(b.priced) || (a.food.name > b.food.name ? 1 : a.food.name < b.food.name ? -1 : 0)
  );

  return {
    rows: sorted.slice(0, limit),
    total: sorted.length,
    counts: {
      all: all.length,
      priced: all.filter((r) => r.priced).length,
      noprice: all.filter((r) => !r.priced && !r.noMoney).length,
      nomoney: all.filter((r) => r.noMoney).length,
      instock: all.filter((r) => r.stock).length
    }
  };
}
