// 库存流水：购买入库（+）与做饭扣减（−）。都带业务唯一键，重复调用不会重复记账。
// 做饭扣减按批次「日期早的先扣」，扣到 0 为止，不出现负库存。

import { convert } from "./units.js?v=4d701ad";
import { purchaseSourceKey, cookSourceKey } from "./idempotency.js?v=4d701ad";
import { uid } from "./ids.js?v=4d701ad";

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// 注意：批次是采购/消耗/撤销的账目单位，不在数据层自动合并或删除。
// 同一样食材显示成一行是界面的事（见 views.js 的冰箱分组），
// 数据里必须保留每一批，否则改一次采购、撤销一次做饭就对不上账。

export function stockInPurchase(data, input) {
  const sourceKey =
    input.sourceKey ||
    purchaseSourceKey({
      storeId: input.storeId,
      dateISO: (input.purchasedAt || new Date().toISOString()).slice(0, 10),
      foodId: input.foodId,
      quantity: input.quantity,
      unit: input.unit,
      amountPence: input.amountPence,
      nonce: input.nonce
    });

  if (data.stockLedger.some((e) => e.type === "purchase_in" && e.sourceKey === sourceKey)) {
    return { data, skipped: true, sourceKey };
  }

  const purchaseId = input.id || uid("purchase");
  const batchId = uid("batch");
  const purchasedAt = input.purchasedAt || new Date().toISOString();
  const unitCostPence = input.amountPence != null && input.quantity > 0 ? input.amountPence / input.quantity : null;

  const purchase = {
    id: purchaseId,
    foodId: input.foodId,
    purchasedAt,
    quantity: input.quantity,
    unit: input.unit,
    amountPence: input.amountPence == null ? null : input.amountPence,
    storeId: input.storeId == null ? null : input.storeId,
    timing: input.timing || "main",
    status: input.status || (input.amountPence == null ? "pending" : "complete"),
    stocked: true,
    sourceKey,
    ...(input.note ? { note: input.note } : {})
  };

  const batch = {
    id: batchId,
    foodId: input.foodId,
    location: input.location || "fridge",
    quantityState: "exact",
    quantity: input.quantity,
    unit: input.unit,
    dateType: input.dateType || "unknown",
    date: input.date == null ? null : input.date,
    addedAt: input.addedAt || purchasedAt.slice(0, 10),
    opened: false,
    unitCostPence,
    sourcePurchaseId: purchaseId
  };

  const ledger = {
    id: uid("ledger"),
    at: purchasedAt,
    type: "purchase_in",
    foodId: input.foodId,
    batchId,
    quantity: input.quantity,
    unit: input.unit,
    sourceKey
  };

  return {
    data: {
      ...data,
      purchases: [...data.purchases, purchase],
      inventoryBatches: [...data.inventoryBatches, batch],
      stockLedger: [...data.stockLedger, ledger]
    },
    skipped: false,
    sourceKey,
    purchaseId,
    batchId
  };
}

export function cookMeal(data, { mealId, recipe, foods, servings, cookedAt }) {
  const sourceKey = cookSourceKey(mealId);
  if (data.cookLogs.some((c) => c.sourceKey === sourceKey && !c.undoneBy)) {
    return { data, skipped: true, sourceKey };
  }

  const foodsById = new Map(foods.map((f) => [f.id, f]));
  const batches = data.inventoryBatches.map((b) => ({ ...b }));
  const consumed = [];
  const ledgerAdd = [];
  const at = cookedAt || new Date().toISOString();

  for (const ing of recipe.ingredients) {
    const food = foodsById.get(ing.foodId);
    const amount = (ing.amount * servings) / recipe.baseServings;
    let needUnit = ing.unit;
    let need = amount;
    if (food) {
      const c = convert(food, amount, ing.unit, food.baseUnit);
      if (c.certain) {
        needUnit = food.baseUnit;
        need = c.value;
      }
    }

    const candidates = batches
      .filter((b) => b.foodId === ing.foodId && b.quantityState === "exact" && b.quantity > 0)
      .map((b) => {
        const c = convert(food, b.quantity, b.unit, needUnit);
        return c.certain ? { batch: b, qty: c.value } : null;
      })
      .filter(Boolean)
      .sort((a, b) => String(a.batch.date || "9999-99-99").localeCompare(String(b.batch.date || "9999-99-99")));

    let remaining = need;
    for (const { batch, qty } of candidates) {
      if (remaining <= 1e-9) break;
      const take = Math.min(qty, remaining);
      const back = convert(food, take, needUnit, batch.unit);
      const takeInBatchUnit = back.certain ? back.value : take;
      batch.quantity = Math.max(0, round3(batch.quantity - takeInBatchUnit));
      remaining -= take;
      consumed.push({ foodId: ing.foodId, quantity: round3(takeInBatchUnit), unit: batch.unit, batchId: batch.id });
      ledgerAdd.push({
        id: uid("ledger"),
        at,
        type: "cook_out",
        foodId: ing.foodId,
        batchId: batch.id,
        quantity: -round3(takeInBatchUnit),
        unit: batch.unit,
        sourceKey: `${sourceKey}|${ing.foodId}|${batch.id}`
      });
    }
    if (remaining > 1e-6) {
      consumed.push({ foodId: ing.foodId, quantity: 0, unit: needUnit, batchId: null, shortfall: round3(remaining) });
    }
  }

  const cookLog = {
    id: uid("cook"),
    mealId,
    cookedAt: at,
    actualServings: servings,
    // 把「这顿吃的是哪道菜」写进做饭记录本身：以后菜单被清空、食谱被删掉，
    // 「这周吃了什么」也还查得出来（老记录没有这两个字段，回看时去餐次上找）。
    recipeId: recipe.id || null,
    recipeName: recipe.name || null,
    consumed,
    sourceKey,
    undoneBy: null
  };

  return {
    data: {
      ...data,
      meals: data.meals.map((m) => (m.id === mealId ? { ...m, state: "done" } : m)),
      inventoryBatches: batches,
      cookLogs: [...data.cookLogs, cookLog],
      stockLedger: [...data.stockLedger, ...ledgerAdd]
    },
    skipped: false,
    sourceKey,
    cookLogId: cookLog.id,
    consumed
  };
}
