// 周界线：默认周六起（settings.budget.weekStartsOn），时区用 settings.budget.timezone。
// 内部统一用「UTC 正午」做日期加减，避免夏令时把日期算偏。

const DOW = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// 把某个时刻按指定时区落成日期（YYYY-MM-DD）。
// cookedAt 之类的时间戳是 UTC 的，直接切前 10 位会把「晚上做的饭」算到前一天，
// 所以「哪天吃的」必须按时区算。
export function dateInTZ(date, timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date instanceof Date ? date : new Date(date));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function todayISO(timeZone = "UTC") {
  return dateInTZ(new Date(), timeZone);
}

function toUTCNoon(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
}

export function addDays(iso, n) {
  return new Date(toUTCNoon(iso) + n * 86400000).toISOString().slice(0, 10);
}

export function weekdayIndex(iso) {
  return new Date(toUTCNoon(iso)).getUTCDay(); // 0 = 周日
}

export function weekStartISO(iso, weekStartsOn = "saturday") {
  const target = DOW.indexOf(weekStartsOn);
  const diff = (weekdayIndex(iso) - target + 7) % 7;
  return addDays(iso, -diff);
}

export function weekRange(iso, weekStartsOn = "saturday") {
  const start = weekStartISO(iso, weekStartsOn);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return { start, end: days[6], days };
}

export function inRange(iso, range) {
  return !range || (iso >= range.start && iso <= range.end);
}

// 往前/往后挪几周（weekStart 得是某周的起点，也就是 weekRange().start）
export function shiftWeek(weekStart, delta) {
  return addDays(weekStart, delta * 7);
}

export const WEEKDAY_LABEL = { 0: "周日", 1: "周一", 2: "周二", 3: "周三", 4: "周四", 5: "周五", 6: "周六" };
