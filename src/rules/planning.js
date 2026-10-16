// 采购清单生成：需要补买 = 尚未完成的菜单需求 − 可用库存，再按包装规格决定买几包。
// 库存不够时才买；同一批库存只会被算一次，不会重复分给多道菜。

import { convert } from "./units.js?v=4d701ad";
import { scaleAmount } from "./servings.js?v=4d701ad";
import { inRange } from "./week.js?v=4d701ad";
import { hasStock } from "./expiry.js?v=4d701ad";

export const NEEDS_COOKING = ["planned", "cooking"];
const AREA_ORDER = ["meat", "fish", "veg", "fruit", "dairy", "staple", "seasoning", "other"];

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export function mealsNeedingCook(meals, range) {
  return meals.filter((m) => NEEDS_COOKING.includes(m.state) && m.recipeId && inRange(m.date, range));
}

export function aggregateRequirements(meals, recipes, foods) {
  const recipesById = new Map(recipes.map((r) => [r.id, r]));
  const foodsById = new Map(foods.map((f) => [f.id, f]));
  const buckets = new Map();
  const uncertain = [];

  for (const meal of meals) {
    const recipe = recipesById.get(meal.recipeId);
    if (!recipe) continue;
    const servings = meal.actualServings != null ? meal.actualServings : recipe.baseServings;
    for (const ing of recipe.ingredients) {
      const food = foodsById.get(ing.foodId);
      const amount = scaleAmount(ing.amount, recipe.baseServings, servings);
      let unit = ing.unit;
      let value = amount;
      let certain = true;
      if (food) {
        const c = convert(food, amount, ing.unit, food.baseUnit);
        if (c.certain) {
          unit = food.baseUnit;
          value = c.value;
        } else {
          certain = false;
        }
      }
      if (!certain) uncertain.push({ mealId: meal.id, foodId: ing.foodId, amount, unit: ing.unit });
      // 同一样食材只出一行：能换算的都先换成基础单位再合并，
      // 否则「生抽 10g」和「生抽 15ml」会各占一行，勾选的时候还容易认错行。
      const key = certain ? ing.foodId : `${ing.foodId}|${unit}`;
      const cur = buckets.get(key) || { foodId: ing.foodId, unit, need: 0, certain: true, firstDate: null };
      cur.need += value;
      if (!certain) cur.certain = false;
      // 这一样食材最早哪天要用：判断库存够不够时按那一天算（use-by 过了就不能算）
      if (!cur.firstDate || meal.date < cur.firstDate) cur.firstDate = meal.date;
      buckets.set(key, cur);
    }
  }
  return { requirements: [...buckets.values()], uncertain };
}

export function availableQuantity(food, unit, batches, { onDate } = {}) {
  let qty = 0;
  let uncertain = false;
  let expired = 0;
  let expiresBeforeUse = 0;
  for (const b of batches) {
    if (!food || b.foodId !== food.id) continue;
    // 吃完的批次既不算可用量，也不该被算成「冰箱里有 N 批用不上」
    if (!hasStock(b)) continue;
    if (b.quantityState !== "exact") {
      uncertain = true; // 档位不假装精确
      continue;
    }
    // use-by 是食品安全日期：到那天之后就不能再吃了。
    // 但「估算」出来的日期只是按保鲜期猜的，不能拿它把库存一笔勾销 ——
    // 只提醒（按估算日期会赶不上这顿），仍然算可用；包装上印的日期才硬排除。
    if (onDate && b.dateType === "use_by" && b.date && b.date < onDate) {
      if (b.dateSource === "estimate") {
        expiresBeforeUse += 1;
      } else {
        expired += 1;
        continue;
      }
    }
    const c = convert(food, b.quantity, b.unit, unit);
    if (c.certain) qty += c.value;
    else uncertain = true;
  }
  return { qty, uncertain, expired, expiresBeforeUse };
}

export function defaultPack(food, unit) {
  if (!food || !food.packSizes || food.packSizes.length === 0) return null;
  return food.packSizes.find((p) => p.unit === unit) || food.packSizes[0];
}

// 一道菜按参考价折算的食材成本，逐样列出来（缺价的单独标）。
// 用于比较菜品、也在「这道菜多少钱」的二级页里显示。
export function recipeCostBreakdown(recipe, foods, servings, { batches = [], purchases = [] } = {}) {
  const foodsById = new Map(foods.map((f) => [f.id, f]));
  // 库存优先：先用冰箱里的批次抵掉用量。
  // 「库存·没花钱」的批次成本按 0 算 —— 登记成库存的东西就当免费。
  const purchaseById = new Map(purchases.map((p) => [p.id, p]));
  const stock = new Map();
  for (const b of batches) {
    if (b.quantityState !== "exact" || !(Number(b.quantity) > 0)) continue;
    const p = b.sourcePurchaseId ? purchaseById.get(b.sourcePurchaseId) : null;
    const free = p ? p.storeId === "stock" : false;
    const unit = free ? 0 : b.unitCostPence != null ? b.unitCostPence : null;
    const list = stock.get(b.foodId) || [];
    list.push({ qty: Number(b.quantity), unit: b.unit, unitCost: unit, free });
    stock.set(b.foodId, list);
  }
  const rows = [];
  let pence = 0;
  let unpriced = 0;
  let freePence = 0;
  for (const ing of recipe.ingredients) {
    const food = foodsById.get(ing.foodId);
    const amount = scaleAmount(ing.amount, recipe.baseServings, servings);
    // 先看库存能抵多少
    let needFromStock = amount;
    let stockPence = null;
    let freeUsed = 0;
    const list = food ? stock.get(food.id) || [] : [];
    for (const s of list) {
      if (needFromStock <= 1e-9) break;
      if (s.qty <= 0) continue;
      const c = convert(food, Math.min(s.qty, needFromStock), food.baseUnit, ing.unit);
      if (!c.certain) continue;
      const take = Math.min(s.qty, needFromStock / (c.value / Math.min(s.qty, needFromStock) || 1) || s.qty);
      const used = Math.min(s.qty, take);
      s.qty -= used;
      needFromStock -= c.value ? Math.min(c.value, needFromStock) : used;
      if (s.free) {
        freeUsed += used;
      } else if (s.unitCost != null) {
        stockPence = (stockPence || 0) + used * s.unitCost;
      } else if (s.unitCost == null && !s.free) {
        stockPence = stockPence; // 价格未知的库存不作数，留给参考价
      }
    }
    const pack = food ? defaultPack(food, ing.unit) : null;
    const restAmount = Math.max(0, needFromStock);
    if (freeUsed > 0) freePence += 0; // 免费部分不再计价
    if (stockPence != null) pence += Math.round(stockPence);
    if (restAmount <= 1e-9) {
      // 全靠库存解决
      rows.push({
        foodId: ing.foodId,
        name: food ? food.name : ing.foodId,
        amount,
        unit: ing.unit,
        pence: stockPence == null ? 0 : Math.round(stockPence),
        fromStock: true,
        free: freeUsed > 0 && stockPence == null
      });
      continue;
    }
    if (!pack || pack.pricePence == null) {
      unpriced++;
      rows.push({
        foodId: ing.foodId,
        name: food ? food.name : ing.foodId,
        amount,
        unit: ing.unit,
        pence: stockPence == null ? null : Math.round(stockPence),
        free: freeUsed > 0,
        reason: "没有参考价"
      });
      continue;
    }
    const c = convert(food, pack.size, pack.unit, ing.unit);
    const packInUnit = c.certain ? c.value : null;
    if (!packInUnit) {
      unpriced++;
      rows.push({
        foodId: ing.foodId,
        name: food.name,
        amount,
        unit: ing.unit,
        pence: stockPence == null ? null : Math.round(stockPence),
        free: freeUsed > 0,
        reason: `包装单位（${pack.unit}）和用量单位（${ing.unit}）换不了`
      });
      continue;
    }
    // 剩下的部分（库存没覆盖的）按参考价折算
    const cost = Math.round((pack.pricePence * restAmount) / packInUnit);
    pence += cost;
    rows.push({
      foodId: ing.foodId,
      name: food.name,
      amount,
      unit: ing.unit,
      pence: cost + (stockPence == null ? 0 : Math.round(stockPence)),
      free: freeUsed > 0,
      packSize: pack.size,
      packUnit: pack.unit,
      packPence: pack.pricePence
    });
  }
  return { pence, unpriced, rows, freePence, servings: servings || recipe.baseServings };
}

// 只要总额和缺价数量时用它
export function recipeCostPence(recipe, foods, servings) {
  const { pence, unpriced } = recipeCostBreakdown(recipe, foods, servings);
  return { pence, unpriced };
}

// timing（大采购 / 顺手补货）由商店在设置里的 role 决定；
// 没配 stores 时退回老规则：Sainsbury's 算补货，其余算大采购。
function timingOf(food, storeRoles) {
  const storeId = (food && food.storeHint) || null;
  if (storeId && storeRoles.has(storeId)) return storeRoles.get(storeId) === "topup" ? "topup" : "main";
  return storeId === "sainsburys" ? "topup" : "main";
}

export function buildShoppingList({ meals, recipes, foods, batches, range, stores }) {
  const foodsById = new Map(foods.map((f) => [f.id, f]));
  const { requirements, uncertain } = aggregateRequirements(mealsNeedingCook(meals, range), recipes, foods);
  const storeRoles = new Map((stores || []).map((s) => [s.id, s.role || "main"]));
  const items = [];
  const warnings = [];

  for (const req of requirements) {
    const food = foodsById.get(req.foodId);
    const stock = availableQuantity(food, req.unit, batches, { onDate: req.firstDate });
    const shortfall = Math.max(0, req.need - stock.qty);
    const item = {
      foodId: req.foodId,
      key: `${req.foodId}|${req.unit}`,
      name: food ? food.name : req.foodId,
      area: food && food.area ? food.area : "other",
      storeId: (food && food.storeHint) || null,
      timing: timingOf(food, storeRoles),
      unit: req.unit,
      need: round3(req.need),
      available: round3(stock.qty),
      availableUncertain: stock.uncertain,
      expiredSkipped: stock.expired || 0,
      expiresBeforeUse: stock.expiresBeforeUse || 0,
      needUncertain: !req.certain,
      shortfall: round3(shortfall),
      packs: null,
      packLabel: null,
      estPence: null,
      leftover: null
    };

    if (shortfall > 0) {
      const pack = defaultPack(food, req.unit);
      if (!pack) {
        item.packs = 1;
        warnings.push(`${item.name}：没有包装规格，按 1 份计`);
      } else {
        const c = convert(food, pack.size, pack.unit, req.unit);
        const packInUnit = c.certain ? c.value : null;
        item.packLabel = `${pack.size}${pack.unit}`;
        if (packInUnit) {
          const packs = Math.ceil(shortfall / packInUnit - 1e-9);
          item.packs = packs;
          item.leftover = round3(packs * packInUnit - shortfall);
          if (pack.pricePence != null) item.estPence = packs * pack.pricePence;
        } else {
          item.packs = 1;
          warnings.push(`${item.name}：包装单位（${pack.unit}）与需求单位（${req.unit}）不可换算，购买量待确认`);
        }
      }
    }
    items.push(item);
  }

  items.sort(
    (a, b) => AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area) || (a.name > b.name ? 1 : a.name < b.name ? -1 : 0)
  );

  const estimatedPence = items.reduce((s, i) => s + (i.estPence || 0), 0);
  const unpriced = items.filter((i) => i.shortfall > 0 && i.estPence == null);
  return { items, budget: { estimatedPence, unpricedCount: unpriced.length }, warnings, uncertain };
}
