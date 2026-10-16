// 纯状态更新函数：给定当前 data，返回新的 data。便于测试，也让界面层保持简单。

import { uid } from "./ids.js?v=4d701ad";
import { convert } from "./units.js?v=4d701ad";

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export function mealIdFor(date) {
  return `meal_${date}_dinner`;
}

export function upsertMeal(data, date, patch) {
  const id = mealIdFor(date);
  const idx = data.meals.findIndex((m) => m.id === id);
  const base =
    idx >= 0
      ? data.meals[idx]
      : { id, date, slot: "dinner", state: "planned", recipeId: null, actualServings: null, servingsConfirmed: false };
  const next = { ...base, ...patch };
  const meals = data.meals.slice();
  if (idx >= 0) meals[idx] = next;
  else meals.push(next);
  return { ...data, meals };
}

export function removeMeal(data, date) {
  const id = mealIdFor(date);
  return { ...data, meals: data.meals.filter((m) => m.id !== id) };
}

// 「本周」里拖动对调两天：
//   · 两天都是做菜（planned / cooking）→ 菜和份数互换，状态跟着菜走；
//   · 一天做菜、另一天闲着 → 整份挪过去，原来那天清空（这就是「拖动调整」）；
//   · 任一天是外食 / 跳过 / 吃剩菜 / 已做完 → 不换，那是你自己定的，让调用方告诉用户原因。
const SWAP_COOKING = ["planned", "cooking"];
const SWAP_STATE_LABEL = { done: "已做完", eating_out: "外食", skipped: "跳过", leftovers: "吃剩菜" };

export function swapMealDays(data, dateA, dateB) {
  if (!dateA || !dateB) return { ok: false, data, reason: "没找到要换的那天" };
  if (dateA === dateB) return { ok: false, data, reason: "同一天不用对调" };
  const find = (d) => data.meals.find((m) => m.id === mealIdFor(d)) || null;
  const a = find(dateA);
  const b = find(dateB);
  const isCooking = (m) => !!m && SWAP_COOKING.includes(m.state);
  const isIdle = (m) => !m || (SWAP_COOKING.includes(m.state) && !m.recipeId);
  const stuck = (m) => !isCooking(m) && !isIdle(m);
  if (stuck(a)) return { ok: false, data, reason: `${dateA.slice(5)} 那天是「${SWAP_STATE_LABEL[a.state] || a.state}」，先改回做菜再对调` };
  if (stuck(b)) return { ok: false, data, reason: `${dateB.slice(5)} 那天是「${SWAP_STATE_LABEL[b.state] || b.state}」，先改回做菜再对调` };
  if (isIdle(a) && isIdle(b)) return { ok: false, data, reason: "这两天都没有安排" };

  const take = (m) =>
    isCooking(m) && m.recipeId
      ? { state: m.state, recipeId: m.recipeId, actualServings: m.actualServings, servingsConfirmed: !!m.servingsConfirmed }
      : null;
  const pa = take(a);
  const pb = take(b);
  let next = data;
  next = pb ? upsertMeal(next, dateA, pb) : removeMeal(next, dateA);
  next = pa ? upsertMeal(next, dateB, pa) : removeMeal(next, dateB);
  return { ok: true, data: next };
}

export function updateSettings(data, { household, budget, stores } = {}) {
  const settings = { ...data.settings };
  if (household) settings.household = { ...settings.household, ...household };
  if (budget) settings.budget = { ...settings.budget, ...budget };
  if (stores) settings.stores = stores;
  return { ...data, settings };
}

export function addDraftRecipe(data, name) {
  const recipe = {
    id: uid("recipe"),
    name,
    baseServings: data.settings.household.defaultServings,
    ingredients: [],
    steps: [],
    tags: [],
    status: "draft",
    createdAt: new Date().toISOString()
  };
  return { ...data, recipes: [...data.recipes, recipe] };
}

// 草稿被电脑补全后，由用户确认发布：状态改成 complete，才能排进本周。
export function publishRecipe(data, recipeId) {
  return {
    ...data,
    recipes: data.recipes.map((r) => (r.id === recipeId ? { ...r, status: "complete", publishedAt: new Date().toISOString() } : r))
  };
}

// 已经被菜单引用的食谱不能删，否则那些餐次会指向不存在的东西。
export function recipeInUse(data, recipeId) {
  return (data.meals || []).some((m) => m.recipeId === recipeId);
}

export function removeRecipe(data, recipeId) {
  if (recipeInUse(data, recipeId)) return { data, ok: false, reason: "这道菜已经排进本周了，先去「本周」把它换掉再删。" };
  return { ok: true, data: { ...data, recipes: data.recipes.filter((r) => r.id !== recipeId) } };
}

// 调整食谱：食材、做法、份数都能改
export function updateRecipe(data, recipeId, patch) {
  return {
    ...data,
    recipes: data.recipes.map((r) => (r.id === recipeId ? { ...r, ...patch } : r))
  };
}

// 套用一周推荐菜单：把选中的菜排进对应日期
export function applyWeekPlan(data, picks, servings) {
  let next = data;
  for (const p of picks) {
    next = upsertMeal(next, p.date, {
      state: "planned",
      recipeId: p.recipeId,
      actualServings: servings,
      servingsConfirmed: true
    });
  }
  return next;
}

// 套用「一键优化排期」的结果：按方案重排它列出的那些天（null = 清空），
// 再把方案里说好要扔掉的过期批次删掉。
// 锁定天（外食 / 跳过 / 吃剩菜 / 已做完）和今天以前的天不在 assignments 里，所以不会被碰。
export function applyOptimizedWeek(data, plan, { purgeBatchIds = [] } = {}) {
  let next = data;
  for (const date of Object.keys(plan.assignments || {})) {
    const a = plan.assignments[date];
    if (!a) next = removeMeal(next, date);
    else
      next = upsertMeal(next, date, {
        state: "planned",
        recipeId: a.recipeId,
        actualServings: a.servings,
        servingsConfirmed: true
      });
  }
  // 今天以前没做成、被顺到后面的那几顿：原来的记录要删掉，不然买菜清单里会算两遍
  for (const date of plan.dropMealDates || []) next = removeMeal(next, date);
  // 扔坏掉的库存放在最后：删批次会顺手对齐采购记录，不影响上面的菜单
  for (const id of purgeBatchIds) next = removeBatch(next, id);
  return next;
}

export function newBatch({
  foodId,
  quantity,
  unit,
  location = "fridge",
  dateType = "unknown",
  date = null,
  dateSource,
  addedAt = null,
  note
}) {
  return {
    id: uid("batch"),
    foodId,
    location,
    quantityState: "exact",
    quantity,
    unit,
    dateType,
    date,
    ...(dateSource ? { dateSource } : {}),
    addedAt,
    opened: false,
    ...(note ? { note } : {})
  };
}

export function upsertBatch(data, batch) {
  const idx = data.inventoryBatches.findIndex((b) => b.id === batch.id);
  const arr = data.inventoryBatches.slice();
  if (idx >= 0) arr[idx] = { ...arr[idx], ...batch };
  else arr.push(batch);
  return { ...data, inventoryBatches: arr };
}

// 删库存时顺手把账对齐，避免留下「孤儿采购」（记录说入库了、库存却不在了）：
//   · 这条批次来自一次采购，而那一笔还没填金额 → 它没有账目价值，连采购记录和入库流水一起清掉；
//   · 那一笔真花过钱 → 金额必须留着（那是"已付"的凭据），只把它标成「库存已不在」；
//   · 这笔采购还有别的批次在 → 什么都不动。
export function removeBatch(data, id) {
  const batch = data.inventoryBatches.find((b) => b.id === id);
  const next = { ...data, inventoryBatches: data.inventoryBatches.filter((b) => b.id !== id) };
  const pid = batch && batch.sourcePurchaseId;
  if (!pid) return next;
  const purchase = data.purchases.find((x) => x.id === pid);
  if (!purchase) return next;
  if (next.inventoryBatches.some((b) => b.sourcePurchaseId === pid)) return next;

  if (purchase.amountPence == null) {
    return {
      ...next,
      purchases: next.purchases.filter((x) => x.id !== pid),
      stockLedger: (next.stockLedger || []).filter((e) => !(e.type === "purchase_in" && e.batchId === id))
    };
  }
  return {
    ...next,
    purchases: next.purchases.map((x) => (x.id === pid ? { ...x, stocked: false } : x))
  };
}

export function adjustBatch(data, id, delta) {
  return {
    ...data,
    inventoryBatches: data.inventoryBatches.map((b) =>
      b.id === id ? { ...b, quantity: Math.max(0, Math.round((b.quantity + delta) * 1000) / 1000) } : b
    )
  };
}

export function setPurchasePrice(data, purchaseId, amountPence, storeId) {
  return {
    ...data,
    purchases: data.purchases.map((p) =>
      p.id === purchaseId
        ? { ...p, amountPence, storeId: storeId === undefined ? p.storeId : storeId, status: amountPence == null ? "pending" : "complete" }
        : p
    )
  };
}

// 手动校准一次购买：分量、单位、实付金额、采购点都能改。
// 由这次购买入库的库存批次要同步改数量（差值方式，已经用掉一部分也不会算错），并重算单位成本。
export function calibratePurchase(data, purchaseId, { quantity, unit, amountPence, storeId } = {}) {
  const p = data.purchases.find((x) => x.id === purchaseId);
  if (!p) return data;

  const newQty = Number(quantity);
  const hasQty = Number.isFinite(newQty) && newQty > 0;
  const finalQty = hasQty ? newQty : p.quantity;
  const finalUnit = unit || p.unit;
  const finalPence = amountPence === undefined ? p.amountPence : amountPence;
  const unitCostPence = finalPence != null && finalQty > 0 ? finalPence / finalQty : null;
  const food = (data.foods || []).find((f) => f.id === p.foodId) || null;
  // 换算到批次自己的单位再算差值：500g 用掉 300g 后改成 0.5kg，余量还是 200g，
  // 不能拿「0.5 − 500」去加。
  const inUnit = (qty, from, to) => {
    if (from === to) return qty;
    const c = convert(food, qty, from, to);
    return c.certain ? c.value : null;
  };

  const purchases = data.purchases.map((x) =>
    x.id === purchaseId
      ? {
          ...x,
          quantity: finalQty,
          unit: finalUnit,
          amountPence: finalPence,
          storeId: storeId === undefined ? x.storeId : storeId,
          status: finalPence == null ? "pending" : "complete"
        }
      : x
  );

  const inventoryBatches = data.inventoryBatches.map((b) =>
    b.sourcePurchaseId === purchaseId
      ? (() => {
          const nextInBatch = hasQty ? inUnit(finalQty, finalUnit, b.unit) : null;
          const oldInBatch = hasQty ? inUnit(p.quantity, p.unit, b.unit) : null;
          const quantity =
            nextInBatch == null || oldInBatch == null
              ? b.quantity
              : Math.max(0, round3(b.quantity + (nextInBatch - oldInBatch)));
          return { ...b, quantity, unitCostPence };
        })()
      : b
  );

  return { ...data, purchases, inventoryBatches };
}

// 把一次校准后的规格记为这个食材以后的默认包装，下次采购就按新规格算。
// 分量变了但没给价格时，把旧价格清空（旧价格对应的是旧规格，留着会算错）。
export function setFoodPack(data, foodId, { size, unit, pricePence } = {}) {
  const newSize = Number(size);
  if (!Number.isFinite(newSize) || newSize <= 0 || !unit) return data;
  const foods = data.foods.map((f) => {
    if (f.id !== foodId) return f;
    const packs = Array.isArray(f.packSizes) ? f.packSizes.slice() : [];
    const idx = packs.findIndex((p) => p.unit === unit);
    const prev = idx >= 0 ? packs[idx] : null;
    const sizeChanged = !prev || Number(prev.size) !== newSize;
    const price = pricePence != null ? pricePence : sizeChanged ? null : prev.pricePence;
    const next = { size: newSize, unit };
    if (prev && prev.label) next.label = prev.label;
    if (price != null) next.pricePence = price;
    if (idx >= 0) packs[idx] = next;
    else packs.unshift(next);
    return { ...f, packSizes: packs };
  });
  return { ...data, foods };
}

// 撤销一次采购：删掉采购记录和它入库的库存，并记一条反向流水（历史保留）。
// 如果这批货已经被做饭用掉过，就不让撤销——那样库存和做饭记录会对不上，改分量更稳妥。
export function undoPurchase(data, purchaseId) {
  const p = data.purchases.find((x) => x.id === purchaseId);
  if (!p) return { data, ok: false, reason: "找不到这条采购记录" };

  const batches = data.inventoryBatches.filter((b) => b.sourcePurchaseId === purchaseId);
  const batchIds = new Set(batches.map((b) => b.id));
  // 「用过」按还没撤销的做饭记录算：撤销过的那顿，食材已经还回来了，可以正常撤销采购
  const used = data.cookLogs.some(
    (c) => !c.undoneBy && (c.consumed || []).some((x) => x.batchId && batchIds.has(x.batchId))
  );
  if (used) {
    return { data, ok: false, reason: "这批货已经用来做过饭了，直接撤销会和做饭记录对不上；点「改分量 / 价格」调整更稳妥。" };
  }

  const at = new Date().toISOString();
  const undos = batches.map((b) => ({
    id: uid("ledger"),
    at,
    type: "undo",
    foodId: p.foodId,
    batchId: b.id,
    quantity: -round3(b.quantity),
    unit: b.unit,
    sourceKey: `undo:${p.sourceKey}`,
    note: "撤销采购"
  }));

  return {
    ok: true,
    data: {
      ...data,
      purchases: data.purchases.filter((x) => x.id !== purchaseId),
      inventoryBatches: data.inventoryBatches.filter((b) => b.sourcePurchaseId !== purchaseId),
      stockLedger: [...data.stockLedger, ...undos]
    }
  };
}

// 撤销「做完」：把扣掉的量还回批次，做饭记录标记为已撤销，餐次回到「已安排」。
export function undoCook(data, mealId) {
  const log = data.cookLogs.find((c) => c.mealId === mealId && !c.undoneBy);
  if (!log) return { data, ok: false, reason: "这条做饭记录已经撤销过了" };

  const at = new Date().toISOString();
  const undoId = uid("ledger");
  const byId = new Map(data.inventoryBatches.map((b) => [b.id, { ...b }]));
  const undos = [];
  const missing = [];

  for (const c of log.consumed) {
    if (!c.batchId || !c.quantity) continue;
    const b = byId.get(c.batchId);
    if (!b) {
      // 批次被删过（比如手动删了库存），这批消耗补不回来 —— 得告诉用户，别装作成功
      missing.push(c.foodId);
      continue;
    }
    b.quantity = round3(b.quantity + c.quantity);
    undos.push({
      id: uid("ledger"),
      at,
      type: "undo",
      foodId: c.foodId,
      batchId: c.batchId,
      quantity: round3(c.quantity),
      unit: c.unit,
      sourceKey: `undo:cook:${mealId}`,
      note: "撤销做饭"
    });
  }

  return {
    ok: true,
    missing: [...new Set(missing)],
    data: {
      ...data,
      inventoryBatches: [...byId.values()],
      cookLogs: data.cookLogs.map((c) => (c.id === log.id ? { ...c, undoneBy: undoId } : c)),
      stockLedger: [...data.stockLedger, ...undos],
      meals: data.meals.map((m) => (m.id === mealId ? { ...m, state: "planned" } : m))
    }
  };
}
