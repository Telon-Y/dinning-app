// 保质期提醒：把库存批次按到期日排出「已过期 / 临期 / 正常 / 日期未确认」。
// 只认明确写过的日期；没填日期的不猜，标成未确认。

export const WARN_DAYS = 3;

function addDaysISO(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 换了「放入日期」之后，到期日该挪到哪天：保持保质天数不变。
// 例：10-12 放入、10-15 到期；把放入日期改成 10-14 → 到期 10-17。
export function shiftExpiryDate(date, prevAdded, added) {
  if (!date || !prevAdded || !added) return null;
  const delta = daysUntil(added, prevAdded); // (added - prevAdded) 天
  if (delta == null || delta === 0) return null;
  return addDaysISO(date, delta);
}

// 按食材的保鲜期估算到期日，入库时自动带上，你只在包装上写了别的日期时才改。
// 肉、水产、乳制品按食品安全算（use-by），其余按品质（best-before）。
export function estimateBatchDates(food, { addedAt, location } = {}) {
  const life = (food && food.shelfLifeDays) || {};
  const place = location && life[location] != null
    ? location
    : ["fridge", "freezer", "pantry", "counter"].find((k) => life[k] != null);
  if (!place || !addedAt || !(life[place] > 0)) return null;
  const date = addDaysISO(addedAt, life[place]);
  if (!date) return null;
  return {
    dateType: ["meat", "fish", "dairy"].includes(food.area) ? "use_by" : "best_before",
    date,
    dateSource: "estimate"
  };
}

// 给所有还没填日期的库存自动补上估算到期日（不需要你手动保存一遍）。
// 用得着你动手的只有「包装上写了别的日期」这一种情况。
export function backfillBatchDates(data, todayISODate) {
  const foodsById = new Map(((data && data.foods) || []).map((f) => [f.id, f]));
  let filled = 0;
  const batches = ((data && data.inventoryBatches) || []).map((b) => {
    // 估算来的日期要一直跟「放入日期 + 保鲜期」保持一致，漂了就纠回来
    if (b.dateSource === "estimate") {
      const est = estimateBatchDates(foodsById.get(b.foodId), {
        addedAt: b.addedAt || todayISODate,
        location: b.location
      });
      if (!est || est.date === b.date) return b;
      filled += 1;
      return { ...b, ...est };
    }
    if (b.date && b.dateType !== "unknown") return b; // 包装上的日期：不动
    if (b.dateSource === "none") return b; // 你明确说过「日期未确认」，就别再猜
    const est = estimateBatchDates(foodsById.get(b.foodId), {
      addedAt: b.addedAt || todayISODate,
      location: b.location
    });
    if (!est) return b;
    filled += 1;
    return { ...b, ...est };
  });
  if (!filled) return { data, filled: 0 };
  return { data: { ...data, inventoryBatches: batches }, filled };
}

export function daysUntil(dateISO, todayISODate) {
  if (!dateISO) return null;
  const a = Date.parse(String(dateISO) + "T00:00:00Z");
  const b = Date.parse(String(todayISODate) + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

export function expiryInfo(batch, todayISODate, warnDays = WARN_DAYS) {
  const estimated = !!(batch && batch.dateSource === "estimate");
  if (!batch || batch.dateType === "unknown" || !batch.date) return { level: "unknown", days: null, estimated };
  const days = daysUntil(batch.date, todayISODate);
  if (days == null) return { level: "unknown", days: null, estimated };
  if (days < 0) return { level: "expired", days, estimated };
  if (days <= warnDays) return { level: "soon", days, estimated };
  return { level: "ok", days, estimated };
}

export function expiryLabel(info) {
  if (!info || info.level === "unknown") return "日期未确认";
  if (info.level === "expired") return `已过期 ${Math.abs(info.days)} 天`;
  if (info.days === 0) return "今天到期";
  return `还剩 ${info.days} 天`;
}

function rank(info) {
  if (info.level === "expired") return 0;
  if (info.level === "soon") return 1;
  if (info.level === "ok") return 2;
  return 3;
}

// 过期的排最前，然后按到期日从近到远，没填日期的垫底。
export function sortByExpiry(batches, todayISODate) {
  return batches
    .map((b) => ({ b, info: expiryInfo(b, todayISODate) }))
    .sort((x, y) => {
      const rx = rank(x.info);
      const ry = rank(y.info);
      if (rx !== ry) return rx - ry;
      if (x.info.days == null && y.info.days == null) return 0;
      if (x.info.days == null) return 1;
      if (y.info.days == null) return -1;
      return x.info.days - y.info.days;
    })
    .map((x) => x.b);
}

// 这批库存还算不算「有货」。做饭扣减只把数量扣到 0、不删批次（批次是记账单位），
// 所以光看到期日会把吃完的东西也排进提醒里。「冰箱」页也按同一条规则过滤，两边必须一致。
// 档位库存（quantityState !== "exact"）没有精确数字，不能当成 0，照旧提醒。
export function hasStock(batch) {
  if (!batch) return false;
  if (batch.quantityState !== "exact") return true;
  return (Number(batch.quantity) || 0) > 0;
}

// 需要提醒的：还有货 + 已经过期 / 快到期的。已经吃完的（0 存量）不提醒。
export function expiringBatches(batches, todayISODate, warnDays = WARN_DAYS) {
  return sortByExpiry(batches.filter(hasStock), todayISODate).filter((b) => {
    const info = expiryInfo(b, todayISODate, warnDays);
    return info.level === "expired" || info.level === "soon";
  });
}
