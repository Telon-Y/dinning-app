// 价格历史：把每次采购的实付金额按食材攒起来，换算出可比的单位价。
// 单位价是跨规格比较的关键：500g £3.20 和 1kg £6.00 直接比不出来，换成 £/kg 就清楚了。

import { formatPence } from "./money.js?v=4d701ad";

export function unitPricePence(amountPence, quantity) {
  if (amountPence == null || !(quantity > 0)) return null;
  return amountPence / quantity;
}

// 按克买就报 £/kg，按毫升买报 £/L，其余按个数。
export function unitPriceText(perUnitPence, unit) {
  if (perUnitPence == null) return "—";
  if (unit === "g") return `${formatPence(Math.round(perUnitPence * 1000))}/kg`;
  if (unit === "ml") return `${formatPence(Math.round(perUnitPence * 1000))}/L`;
  return `${formatPence(Math.round(perUnitPence))}/${unit}`;
}

// 最近一次填过价格的采购（用来给下次填价格当默认值）
export function lastKnownPrice(data, foodId, excludePurchaseId) {
  const list = ((data && data.purchases) || []).filter(
    (p) => p.foodId === foodId && p.amountPence != null && p.id !== excludePurchaseId
  );
  if (!list.length) return null;
  list.sort((a, b) => (String(a.purchasedAt) < String(b.purchasedAt) ? 1 : -1));
  return list[0];
}

export function foodPriceHistory(data, foodId) {
  const storeNames = new Map((((data && data.settings && data.settings.stores) || [])).map((s) => [s.id, s.name]));
  const storeLabel = (id) => (id === "stock" ? "库存（没花钱）" : id ? storeNames.get(id) || id : "未记录");
  const entries = ((data && data.purchases) || [])
    .filter((p) => p.foodId === foodId)
    .map((p) => ({
      id: p.id,
      at: String(p.purchasedAt || "").slice(0, 10),
      store: storeLabel(p.storeId),
      quantity: p.quantity,
      unit: p.unit,
      amountPence: p.amountPence == null ? null : p.amountPence,
      unitPricePence: unitPricePence(p.amountPence, p.quantity)
    }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const priced = entries.filter((e) => e.amountPence != null);

  // 按「店 + 单位」归并：不同单位的单位价不能直接比
  const buckets = new Map();
  for (const e of priced) {
    const key = `${e.store}|${e.unit}`;
    const cur = buckets.get(key) || { store: e.store, unit: e.unit, count: 0, sum: 0, n: 0, cheapest: e, latest: e };
    cur.count += 1;
    if (e.unitPricePence != null) {
      cur.sum += e.unitPricePence;
      cur.n += 1;
      if (cur.cheapest.unitPricePence == null || e.unitPricePence < cur.cheapest.unitPricePence) cur.cheapest = e;
    }
    buckets.set(key, cur);
  }

  const stores = [...buckets.values()].map((s) => ({
    store: s.store,
    unit: s.unit,
    count: s.count,
    latest: s.latest,
    cheapestUnitPence: s.cheapest.unitPricePence,
    avgUnitPence: s.n ? s.sum / s.n : null
  }));

  return { entries, pricedCount: priced.length, latest: priced[0] || null, stores };
}
