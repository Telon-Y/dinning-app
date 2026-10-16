// 吃的历史：把「真正吃过」的菜按天、按周留下来，给「本周 → 吃的日历」回看。
//
// 为什么事实源要用做饭记录、而不是排期：排了不等于吃了。
// 一条历史按优先级从两处来：
//   1. cookLogs 里没被撤销的 —— 真正下厨过的；
//   2. meals 里 state = "done"、但没有对应 cookLog 的老记录。
//
// 「归到哪一天」用**餐次那天**，不是按钮按下去的时刻：这个应用一天只有一顿正餐，
// 「本周」也是按餐次日期显示的。拿 cookedAt 归日子会出现「本周四那顿算到上周」这种
// 和「本周」对不上的情况（真实数据里就有：10-16 那顿的做饭记录是 10-13 按的）。
// 只有餐次已经被清空、找不到的时候，才退回按 cookedAt + 时区去定那天 ——
// 晚上 11 点做的饭 UTC 已经是第二天，直接切前 10 位会算错。
// cookedAt 仍然留着，界面上写「几点做的 / 实际哪天下的厨」。
//
// 早期 cookLog 没有 recipeId，菜名要去当时的餐次上找；再找不到就只留「做过一顿」，
// 不猜。新增的 cookLog 会自己带上 recipeId / recipeName，以后就算菜单被清空、
// 食谱被删掉，这周吃过什么也还留着。
//
// 全是纯函数：只读 data，不写。

import { addDays, weekStartISO, weekdayIndex, WEEKDAY_LABEL, dateInTZ } from "./week.js?v=4d701ad";

const MEAL_DATE_RE = /^meal_(\d{4}-\d{2}-\d{2})/;

function mealDateOf(mealId) {
  const m = MEAL_DATE_RE.exec(String(mealId || ""));
  return m ? m[1] : null;
}

// 「哪天吃了什么」的事件流（按日期从早到晚）
export function cookedEvents(data, { timeZone = "UTC" } = {}) {
  const recipesById = new Map((data.recipes || []).map((r) => [r.id, r]));
  const mealsById = new Map((data.meals || []).map((m) => [m.id, m]));
  const nameOf = (recipeId) => {
    const r = recipeId ? recipesById.get(recipeId) : null;
    return r ? r.name : null;
  };

  const events = [];
  const loggedMeals = new Set();
  for (const log of data.cookLogs || []) {
    if (!log || log.undoneBy) continue; // 撤销过的那顿不算吃过
    const meal = mealsById.get(log.mealId) || null;
    const mealDate = meal ? meal.date : mealDateOf(log.mealId);
    const cookedDate = log.cookedAt ? dateInTZ(log.cookedAt, timeZone) : null;
    const recipeId = log.recipeId || (meal && meal.recipeId) || null;
    events.push({
      date: mealDate || cookedDate,
      mealDate,
      cookedDate,
      mealId: log.mealId,
      recipeId,
      name: log.recipeName || nameOf(recipeId),
      servings: log.actualServings != null ? log.actualServings : meal ? meal.actualServings : null,
      cookedAt: log.cookedAt || null,
      source: "cookLog"
    });
    loggedMeals.add(log.mealId);
  }

  for (const meal of data.meals || []) {
    if (!meal || meal.state !== "done" || !meal.recipeId) continue;
    if (loggedMeals.has(meal.id)) continue; // 上面已经算过了
    events.push({
      date: meal.date,
      mealDate: meal.date,
      cookedDate: null,
      mealId: meal.id,
      recipeId: meal.recipeId,
      name: nameOf(meal.recipeId),
      servings: meal.actualServings != null ? meal.actualServings : null,
      cookedAt: null,
      source: "meal"
    });
  }

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return events;
}

export function eventsByWeek(events, weekStartsOn = "saturday") {
  const map = new Map();
  for (const e of events) {
    if (!e.date) continue;
    const wk = weekStartISO(e.date, weekStartsOn);
    if (!map.has(wk)) map.set(wk, []);
    map.get(wk).push(e);
  }
  return map;
}

// 每道菜「做过的日期」列表（升序、去重），用来回答「这道菜上次做是什么时候」
export function cookedDatesByRecipe(events) {
  const sets = new Map();
  for (const e of events) {
    if (!e.recipeId || !e.date) continue;
    if (!sets.has(e.recipeId)) sets.set(e.recipeId, new Set());
    sets.get(e.recipeId).add(e.date);
  }
  const out = new Map();
  for (const [id, set] of sets) out.set(id, [...set].sort());
  return out;
}

// 某天之前最后一次做的日期（不含那天本身；没有就 null）
export function lastCookedBefore(dates, date) {
  if (!dates || !dates.length || !date) return null;
  let found = null;
  for (const d of dates) {
    if (d < date) found = d;
    else break;
  }
  return found;
}

export function weekRangeOf(weekStart) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  return { start: weekStart, end: days[6], days };
}

// 一天的「结果」：吃了什么 / 外食 / 跳过 / 吃剩菜 / 定了还没做 / 排了没做 / 没安排。
// 注意「没做」只对已经过去的日子说 —— 今天还没过完，今天定了菜不叫没做。
function dayOutcome(meal, eaten, date, today) {
  if (eaten.length) return "cooked";
  const state = meal ? meal.state : null;
  if (state === "eating_out") return "eating_out";
  if (state === "skipped") return "skipped";
  if (state === "leftovers") return "leftovers";
  if (state === "planned" || state === "cooking") return today && date < today ? "missed" : "planned";
  if (today && date > today) return "future";
  return "empty";
}

const STAT_KEY = {
  cooked: "cooked",
  eating_out: "eatingOut",
  skipped: "skipped",
  leftovers: "leftovers",
  missed: "missed",
  planned: "planned",
  future: "future",
  empty: "empty"
};

// 某一周：7 天各是什么结果 + 这周的统计
export function weekHistory(data, { weekStart, weekStartsOn = "saturday", timeZone = "UTC", today } = {}) {
  const events = cookedEvents(data, { timeZone });
  const range = weekRangeOf(weekStart);
  const byDate = new Map();
  for (const e of events) {
    if (e.date < range.start || e.date > range.end) continue;
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }

  const stats = { cooked: 0, eatingOut: 0, skipped: 0, leftovers: 0, missed: 0, planned: 0, future: 0, empty: 0, dishes: 0 };
  const days = range.days.map((d) => {
    const meal = (data.meals || []).find((m) => m.date === d) || null;
    const eaten = byDate.get(d) || [];
    const kind = dayOutcome(meal, eaten, d, today);
    const key = STAT_KEY[kind];
    if (key) stats[key] += 1;
    const planned = meal && meal.recipeId ? (data.recipes || []).find((r) => r.id === meal.recipeId) || null : null;
    stats.dishes += eaten.filter((e) => e.recipeId).length;
    return {
      date: d,
      weekday: WEEKDAY_LABEL[weekdayIndex(d)],
      kind,
      eaten,
      mealState: meal ? meal.state : null,
      planned: planned ? { recipeId: planned.id, name: planned.name } : null,
      plannedServings: meal && meal.actualServings != null ? meal.actualServings : null
    };
  });

  return { weekStart: range.start, weekEnd: range.end, days, stats, events: days.flatMap((d) => d.eaten) };
}

// 月历：按周起点铺 6 行 × 7 列（够放任何一个月），每格给出那天是什么结果
export function monthGrid(data, { year, month, weekStartsOn = "saturday", timeZone = "UTC", today } = {}) {
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const gridStart = weekStartISO(`${monthKey}-01`, weekStartsOn);
  const events = cookedEvents(data, { timeZone });
  const byDate = new Map();
  for (const e of events) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const date = addDays(gridStart, i);
    const inMonth = date.slice(0, 7) === monthKey;
    const meal = (data.meals || []).find((m) => m.date === date) || null;
    const eaten = byDate.get(date) || [];
    let kind = dayOutcome(meal, eaten, date, today);
    // 别的月那几天不标状态，只是淡着显示日期
    if (!inMonth && (kind === "empty" || kind === "future")) kind = "outside";
    cells.push({
      date,
      dayNumber: Number(date.slice(8, 10)),
      inMonth,
      kind,
      eaten,
      names: eaten.map((e) => e.name).filter(Boolean)
    });
  }
  return { year, month, monthKey, gridStart, cells };
}

export function monthLabel(year, month) {
  return `${year} 年 ${month} 月`;
}

// 往前/往后挪一个月（month 是 1-12）
export function shiftMonth(year, month, delta) {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
