// 金额一律以整数「便士」存储与计算，避免浮点误差。
// 详细规则见 docs/M0-业务规则.md。

export function poundsToPence(pounds) {
  return Math.round(Number(pounds) * 100);
}

export function formatPence(pence) {
  const value = Number(pence);
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(Math.round(value));
  const pounds = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  return `${sign}£${pounds}.${cents}`;
}

// 按用量分摊整包金额：packPence 为整包价格，used / packSize 必须是同一基础单位。
// half-up 舍入，结果仍为整数便士。
export function apportionPence(packPence, used, packSize) {
  if (!(packSize > 0)) throw new Error("packSize 必须大于 0");
  if (used < 0) throw new Error("used 不能为负");
  return Math.round((packPence * used) / packSize);
}

// 预算条怎么画：已付的钱和「还要买」的预计各占一段，两段合起来才是这周要花的。
// 以前只按预计画，实际花了多少在条子上看不出来。
export function budgetBar({ budgetPence, paidPence, estimatePence } = {}) {
  const budget = Math.max(0, Number(budgetPence) || 0);
  const paid = Math.max(0, Number(paidPence) || 0);
  const estimate = Math.max(0, Number(estimatePence) || 0);
  const spentPence = paid + estimate;
  const totalPct = budget > 0 ? Math.min(100, Math.round((spentPence / budget) * 100)) : 0;
  const paidPct = budget > 0 ? Math.min(totalPct, Math.round((paid / budget) * 100)) : 0;
  return {
    spentPence,
    leftPence: budget - spentPence,
    over: spentPence > budget,
    totalPct,
    paidPct,
    estimatePct: totalPct - paidPct
  };
}
