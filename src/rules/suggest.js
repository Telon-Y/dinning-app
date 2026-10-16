// 剩余食材推荐：拿冰箱里现有的东西，挑出「能做/差一点就能做」的菜。
// 排序偏好：用掉的现有食材越多、还缺的越少、能顺手消耗快过期的东西越多，排越前。

import { convert } from "./units.js?v=4d701ad";
import { expiryInfo, hasStock } from "./expiry.js?v=4d701ad";
import { isMealDish } from "./mealtags.js?v=4d701ad";

// 把库存按食材聚合到基础单位。
// onDate（通常是今天或这顿饭的日期）：use-by 已经过了的批次不算可用 —— 那是食品安全日期。
export function stockByFood(data, { onDate, skipExpired = true } = {}) {
  const foodsById = new Map(data.foods.map((f) => [f.id, f]));
  const map = new Map();
  for (const b of data.inventoryBatches || []) {
    // 吃完的批次没有可用量（加 0 也是 0），统一走 hasStock，免得以后各写一套判据
    if (b.quantityState !== "exact" || !hasStock(b)) continue;
    const f = foodsById.get(b.foodId);
    if (!f) continue;
    if (skipExpired && onDate && b.dateType === "use_by" && b.date && b.date < onDate) continue;
    const c = convert(f, b.quantity, b.unit, f.baseUnit);
    if (!c.certain) continue;
    const cur = map.get(b.foodId) || { qty: 0, unit: f.baseUnit };
    cur.qty += c.value;
    map.set(b.foodId, cur);
  }
  return map;
}

export function suggestRecipes(data, { limit = 8, today, servings, maxMissing = 3, minUsed = 2 } = {}) {
  const foodsById = new Map(data.foods.map((f) => [f.id, f]));
  const stock = stockByFood(data, { onDate: today });
  const target =
    servings || (data.settings && data.settings.household ? data.settings.household.defaultServings : 2);

  // 快过期 / best-before 过了的食材，能顺手用掉是加分项；
  // 但 use-by 已过的不能再吃，不算加分项（那些批次也已经不计入库存了）；
  // 已经吃完的批次（0 存量）同样不算 —— 它没什么可「顺手用掉」的。
  const warnFoods = new Set();
  for (const b of data.inventoryBatches || []) {
    if (!hasStock(b)) continue;
    const info = expiryInfo(b, today);
    if (info.level === "soon") warnFoods.add(b.foodId);
    else if (info.level === "expired" && b.dateType !== "use_by") warnFoods.add(b.foodId);
  }

  const out = [];
  for (const r of data.recipes) {
    if (r.status !== "complete" || !r.ingredients.length) continue;
    if (!isMealDish(r)) continue; // 只有「家常菜 + 正餐」才参与推荐
    const scale = target / r.baseServings;
    let full = 0;
    let partial = 0;
    const missing = []; // 主料缺口：这个才算“还得去买”
    const missingSeasoning = []; // 调料缺口：家里多半有，只是没记进冰箱
    const warnUsed = [];

    for (const ing of r.ingredients) {
      const f = foodsById.get(ing.foodId);
      const need = ing.amount * scale;
      let needBase = need;
      let unit = ing.unit;
      if (f) {
        const c = convert(f, need, ing.unit, f.baseUnit);
        if (c.certain) {
          needBase = c.value;
          unit = f.baseUnit;
        }
      }
      const s = stock.get(ing.foodId);
      const have = s && s.unit === unit ? s.qty : 0;
      const isSeasoning = f && f.area === "seasoning";
      const bucket = isSeasoning ? missingSeasoning : missing;
      if (have >= needBase && needBase > 0) {
        full += 1;
        if (warnFoods.has(ing.foodId)) warnUsed.push(f ? f.name : ing.foodId);
      } else if (have > 0) {
        partial += 1;
        bucket.push({ foodId: ing.foodId, name: f ? f.name : ing.foodId, short: Math.round((needBase - have) * 10) / 10 });
      } else {
        bucket.push({ foodId: ing.foodId, name: f ? f.name : ing.foodId, short: Math.round(needBase * 10) / 10 });
      }
    }

    const total = r.ingredients.length;
    const usedCount = full + partial;
    if (usedCount < minUsed) continue; // 跟你的库存基本没关系，不算「用现有食材」
    if (missing.length > maxMissing) continue; // 缺太多，跟重新买一遍没区别

    const score = ((full + partial * 0.5) / total) * 100 + (warnUsed.length ? 20 : 0) - missing.length * 5;
    out.push({
      recipeId: r.id,
      name: r.name,
      category: r.category || "",
      baseServings: r.baseServings,
      servings: target,
      full,
      partial,
      missing,
      missingSeasoning,
      warnUsed: [...new Set(warnUsed)],
      score: Math.round(score * 10) / 10
    });
  }

  out.sort((a, b) => b.score - a.score || (a.name > b.name ? 1 : -1));
  return { items: out.slice(0, limit), total: out.length };
}
