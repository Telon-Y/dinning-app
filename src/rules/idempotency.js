// 幂等：同一业务动作只能落一次流水。
// 购买入库按「购买来源唯一键」去重，做饭扣减按「餐次唯一键」去重。
// 双击、接口重试、跨设备同步都必须走同一套键。

// nonce：同一次勾选产生的唯一标识。没有它，同一天买同一样东西会算出同一个键，
// 第二次会被当成重复提交而静默跳过（删掉库存后重勾就会「不添加」）。
export function purchaseSourceKey({ storeId, dateISO, foodId, quantity, unit, amountPence, nonce }) {
  return [
    "purchase",
    storeId || "unknown",
    dateISO,
    foodId,
    `${quantity}${unit}`,
    amountPence == null ? "na" : amountPence,
    nonce || "0"
  ].join("|");
}

export function cookSourceKey(mealId) {
  return `cook:${mealId}`;
}

export function undoSourceKey(sourceKey) {
  return `undo:${sourceKey}`;
}

// 同一 type + sourceKey 的流水只允许存在一条。
export function canApplyLedger(entries, type, sourceKey) {
  return !entries.some((e) => e.type === type && e.sourceKey === sourceKey);
}
