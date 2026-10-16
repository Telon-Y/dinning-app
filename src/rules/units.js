// 单位换算：
//  1) 公制/市制之间的换算不需要问食材（kg↔g、l↔ml、斤↔g），按定义直接算；
//  2) 「个 → 克」这种必须靠食材显式声明的 unitConversions，绝不臆测。
// 未知量返回 { value: null, certain: false }，调用方必须保留不确定状态。

// unitConversions 语义：1 个「基础单位」等于多少「目标单位」。
// 例：洋葱 baseUnit = 个，unitConversions = { g: 150 } → 1 个 ≈ 150g。

// 输入单位时给的下拉选项
export const COMMON_UNITS = ["g", "kg", "ml", "l", "个"];

// 同一「物理量」下的固定倍数换算，和食材无关
const METRIC = {
  g: { base: "g", factor: 1 },
  kg: { base: "g", factor: 1000 },
  斤: { base: "g", factor: 500 },
  两: { base: "g", factor: 50 },
  ml: { base: "ml", factor: 1 },
  l: { base: "ml", factor: 1000 },
  L: { base: "ml", factor: 1000 }
};

export function convert(food, amount, from, to) {
  if (from === to) return { value: amount, certain: true };

  const mFrom = METRIC[from];
  const mTo = METRIC[to];
  if (mFrom && mTo && mFrom.base === mTo.base) {
    return { value: (amount * mFrom.factor) / mTo.factor, certain: true };
  }

  const base = food && food.baseUnit;
  const conv = (food && food.unitConversions) || {};

  // 1 个 from/to 单位各等于多少「基础单位」（换算不了返回 null）
  const toBase = (u) => {
    if (u === base) return 1;
    const m = METRIC[u];
    if (m && m.base === base) return m.factor;
    // 「kg → g → 个」这种要接力一次：先按公制退到 g，再靠食材换算退到 个
    if (m && m.base !== u) {
      const inner = toBase(m.base);
      if (inner != null) return m.factor * inner;
    }
    if (typeof conv[u] === "number" && conv[u] !== 0) return 1 / conv[u];
    return null;
  };

  const a = toBase(from);
  const b = toBase(to);
  if (a == null || b == null) return { value: null, certain: false };
  return { value: (amount * a) / b, certain: true };
}

export function isConvertible(food, from, to) {
  if (from === to) return true;
  const mFrom = METRIC[from];
  const mTo = METRIC[to];
  if (mFrom && mTo && mFrom.base === mTo.base) return true;
  const conv = (food && food.unitConversions) || {};
  const base = food && food.baseUnit;
  const reachable = (u, seen = new Set()) => {
    if (u === base) return true;
    if (seen.has(u)) return false;
    seen.add(u);
    const m = METRIC[u];
    if (m && m.base === base) return true;
    if (m && m.base !== u && reachable(m.base, seen)) return true;
    return typeof conv[u] === "number";
  };
  return reachable(from) && reachable(to);
}

// 只有单位可互转时才允许合并用量；否则必须分开列出。
export function canMergeQuantity(food, unitA, unitB) {
  return isConvertible(food, unitA, unitB);
}
