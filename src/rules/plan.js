// 一周推荐菜单：从菜谱库里挑出这一周的正餐。
// 偏好顺序：用掉现成食材多、能顺手消耗快过期的、便宜、不重样；
// 最后用真实采购估算（扣掉库存）校一遍周预算，超了就换成更便宜的。

import { convert } from "./units.js?v=4d701ad";
import { expiryInfo, hasStock } from "./expiry.js?v=4d701ad";
import { recipeCostPence, buildShoppingList } from "./planning.js?v=4d701ad";
import { stockByFood } from "./suggest.js?v=4d701ad";
import { isMealDish } from "./mealtags.js?v=4d701ad";

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 只从"能当一顿饭"的类目里挑：饮品、甜点、调料、半成品不算正餐
const DINNER_CATEGORIES = new Set(["荤菜", "素菜", "水产", "主食", "汤", "早餐", "其他"]);

export function suggestWeek(data, { range, today, servings, budgetPence, seed = 1 } = {}) {
  const target = servings || (data.settings && data.settings.household ? data.settings.household.defaultServings : 2);
  const budget = budgetPence == null ? data.settings.budget.weeklyPence : budgetPence;
  const pool = buildRecipePool(data, { servings: target, today });

  if (!pool.length) {
    return { picks: [], estimatePence: 0, budgetPence: budget, note: "菜谱库里还没有可用的菜" };
  }

  const rnd = mulberry32(seed);
  const shuffled = pool
    .map((c) => ({ ...c, sortKey: c.score + rnd() * 6 }))
    .sort((a, b) => b.sortKey - a.sortKey);

  const days = (range && range.days) || [];
  const used = new Set();
  let prevCat = "";
  const chosen = [];
  for (const date of days) {
    const pick =
      shuffled.find((c) => !used.has(c.recipeId) && c.category !== prevCat) ||
      shuffled.find((c) => !used.has(c.recipeId));
    if (!pick) break;
    used.add(pick.recipeId);
    chosen.push({ ...pick, date });
    prevCat = pick.category;
  }

  // 越"新鲜"的越靠前：叶子菜、鲜肉先吃，干货冷冻留到后面
  chosen.sort((a, b) => b.fresh - a.fresh);
  let final = chosen.map((p, i) => ({ ...p, date: days[i] || p.date }));

  const mealsOf = (ps) =>
    ps.map((p) => ({
      id: `plan_${p.date}`,
      date: p.date,
      slot: "dinner",
      state: "planned",
      recipeId: p.recipeId,
      actualServings: target
    }));
  const listOf = (ps) =>
    buildShoppingList({
      meals: mealsOf(ps),
      recipes: data.recipes,
      foods: data.foods,
      batches: data.inventoryBatches,
      range,
      stores: data.settings.stores
    });
  const estimateOf = (ps) => listOf(ps).budget.estimatedPence;

  for (let guard = 0; guard < 15; guard += 1) {
    const est = estimateOf(final);
    if (est <= budget) break;
    const victim = [...final].sort((a, b) => b.cost - a.cost)[0];
    const usedIds = new Set(final.map((p) => p.recipeId));
    const alt = shuffled
      .filter((c) => !usedIds.has(c.recipeId) && c.cost < victim.cost)
      .sort((a, b) => b.score - a.score)[0];
    if (!alt) break;
    const next = final.map((p) => (p.recipeId === victim.recipeId ? { ...alt, date: p.date } : p));
    if (estimateOf(next) >= est) break;
    final = next;
  }

  const estimatePence = estimateOf(final);
  const unpricedCount = listOf(final).budget.unpricedCount;
  return {
    picks: final,
    estimatePence,
    budgetPence: budget,
    unpricedCount,
    note:
      unpricedCount > 0
        ? `其中 ${unpricedCount} 项还没有参考价，金额不准，买菜时补上就准了`
        : estimatePence > budget
          ? `预计超预算 ${((estimatePence - budget) / 100).toFixed(2)} 英镑`
          : ""
  };
}

// 单日推荐：只给某一天挑一道菜，偏好和一周推荐完全一致。
// 已经排在本周别的日子的菜往后退（不想连着吃同一道），当前这天原本的菜也排除掉。
export function suggestDay(data, { date, today, servings, seed = 1, exclude = [], limit = 6 } = {}) {
  const target = servings || (data.settings && data.settings.household ? data.settings.household.defaultServings : 2);
  const pool = buildRecipePool(data, { servings: target, today });
  if (!pool.length) return { items: [], servings: target, date, note: "菜谱库里还没有可用的菜" };

  const skip = new Set(exclude);
  const mine = `meal_${date}_dinner`;
  const plannedElsewhere = new Set(
    (data.meals || []).filter((m) => m.recipeId && m.id !== mine).map((m) => m.recipeId)
  );
  const current = (data.meals || []).find((m) => m.id === mine);
  if (current && current.recipeId) skip.add(current.recipeId);

  const rnd = mulberry32(seed);
  const items = pool
    .filter((c) => !skip.has(c.recipeId))
    .map((c) => ({
      ...c,
      alreadyPlanned: plannedElsewhere.has(c.recipeId),
      sortKey: c.score - (plannedElsewhere.has(c.recipeId) ? 25 : 0) + rnd() * 6
    }))
    .sort((a, b) => b.sortKey - a.sortKey)
    .slice(0, limit);

  return { items, servings: target, date, note: "" };
}

// 把某一道菜放到某一天之后，本周采购会变成多少钱（扣掉库存），用来在采用前看预算。
export function estimateWithPick(data, { range, date, servings, recipeId }) {
  const mealId = `meal_${date}_dinner`;
  const meals = [
    ...(data.meals || []).filter((m) => m.id !== mealId),
    { id: mealId, date, slot: "dinner", state: "planned", recipeId, actualServings: servings }
  ];
  const list = buildShoppingList({
    meals,
    recipes: data.recipes,
    foods: data.foods,
    batches: data.inventoryBatches,
    range,
    stores: data.settings.stores
  });
  const budget = data.settings.budget.weeklyPence;
  return {
    estimatePence: list.budget.estimatedPence,
    budgetPence: budget,
    unpricedCount: list.budget.unpricedCount,
    over: list.budget.estimatedPence > budget
  };
}

// 候选池：一周推荐、单日推荐、一键优化排期共用，保证三处口味一致。
export function buildRecipePool(data, { servings, today }) {
  const foodsById = new Map(data.foods.map((f) => [f.id, f]));
  const stock = stockByFood(data, { onDate: today });

  const warnFoods = new Set();
  for (const b of data.inventoryBatches || []) {
    if (!hasStock(b)) continue; // 吃完的批次没什么可「顺手消耗」的，不算加分项
    const info = expiryInfo(b, today);
    if (info.level === "soon") warnFoods.add(b.foodId);
    // best-before 过了只是品质差一点，还能吃；use-by 过了就不能再推荐了
    else if (info.level === "expired" && b.dateType !== "use_by") warnFoods.add(b.foodId);
  }

  const pool = [];
  for (const r of data.recipes) {
    if (r.status !== "complete" || !r.ingredients.length) continue;
    if (!isMealDish(r)) continue; // 只有「家常菜 + 正餐」才参与推荐
    if (r.category && !DINNER_CATEGORIES.has(r.category)) continue;
    const scale = servings / r.baseServings;
    let covered = 0;
    let warnHit = 0;
    let fresh = 0;
    const missing = [];
    const missingSeasoning = [];
    const warnUsed = [];
    for (const ing of r.ingredients) {
      const f = foodsById.get(ing.foodId);
      let need = ing.amount * scale;
      let unit = ing.unit;
      if (f) {
        const c = convert(f, need, ing.unit, f.baseUnit);
        if (c.certain) {
          need = c.value;
          unit = f.baseUnit;
        }
      }
      const s = stock.get(ing.foodId);
      const enough = !!(s && s.unit === unit && s.qty >= need);
      if (enough) {
        covered += 1;
        if (warnFoods.has(ing.foodId)) warnUsed.push(f ? f.name : ing.foodId);
      } else if (need > 0) {
        const have = s && s.unit === unit ? s.qty : 0;
        const row = {
          foodId: ing.foodId,
          name: f ? f.name : ing.foodId,
          unit,
          short: Math.round((need - have) * 10) / 10
        };
        (f && f.area === "seasoning" ? missingSeasoning : missing).push(row);
      }
      if (warnFoods.has(ing.foodId)) warnHit += 1;
      const life = (f && f.shelfLifeDays) || {};
      if (f && f.area !== "seasoning" && life.fridge != null && life.freezer == null) fresh += 1;
    }
    const costInfo = recipeCostPence(r, data.foods, servings);
    const pricedShare = r.ingredients.length ? (r.ingredients.length - costInfo.unpriced) / r.ingredients.length : 0;
    // 参考价不全的菜，成本不可信，就别参与"越便宜越优先"的打分
    const reliableCost = pricedShare >= 0.6;
    const cost = costInfo.pence;
    pool.push({
      recipeId: r.id,
      name: r.name,
      category: r.category || "",
      cost,
      reliableCost,
      covered,
      warnHit,
      warnUsed: [...new Set(warnUsed)],
      missing,
      missingSeasoning,
      fresh,
      servings,
      // 家常菜通常 5-8 样食材；太少像小菜，太多像大菜，两头都降一点
      score:
        covered * 10 + warnHit * 30 - (reliableCost ? cost / 30 : 0) - Math.abs(r.ingredients.length - 6) * 1.2
    });
  }
  return pool;
}
