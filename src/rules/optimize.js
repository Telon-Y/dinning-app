// 一键优化排期：把「今天及以后、还没做」的菜重排一遍，让容易坏的先做。
//
// 为什么要有这个：排骨排在周五，可它 use-by 是周三 —— 到那天肉已经坏了。
// 规则（都是从这条教训推出来的）：
//   · 只动「今天及以后 + 还没做（planned / cooking / 空白）」的天。
//     已经做完 / 外食 / 跳过 / 吃剩菜 是你自己定的，一律不碰。
//   · 每道菜按它要用的库存算一个「最晚哪天做」：
//       use_by（包装上印的日期）是硬期限 —— 排在它后面就必须往前挪，挪不动就换菜；
//       best_before 和估算出来的日期只算「尽量提前」—— 挪得动就挪，挪不动不硬来
//       （best-before 过了只是品质差一点，为它把整周翻一遍不值当）。
//   · 往前挪优先跟那天对调（两边都不迟到），其次占空白天，都不行才换菜。
//   · 空出来的天和本来空着的天，用「用得上冰箱现成食材、顺手消耗快过期的」补上。
//   · 最后校一遍周预算：超了就把最贵的换成便宜的（不破坏期限）。
//   · 再顺手抢救一下：这几天就要到期、可一周里没有哪道菜用得上的食材，
//     换一道用得上的菜进来（只换「完全没有期限压力」的那道，最多两道）。
//
// 这个函数是纯的：只读 data，返回一份排期方案，不动 data；落地由 model.js 的
// applyOptimizedWeek 负责，所以能先给用户看一遍再决定。

import { expiryInfo, hasStock } from "./expiry.js?v=4d701ad";
import { buildShoppingList } from "./planning.js?v=4d701ad";
import { buildRecipePool } from "./plan.js?v=4d701ad";

// 「还没做、还能改」的状态：只有这两种状态的天才参与重排
export const COOKING_STATES = ["planned", "cooking"];
export const RESCUE_DAYS = 3; // 这几天内到期的食材，想办法顺手用掉
const RESCUE_MAX = 2; // 一次最多抢救两道，别把整周换掉
const RESCUE_MARGIN = 12; // 抢救的那道菜要比被换掉的分高出这么多才动手

const md = (iso) => (iso ? String(iso).slice(5) : "");
const KIND_RANK = { keep: 0, new: 1, replace: 2, move: 3, swap: 4 };

// 一批库存是不是「已经坏了、不能再吃」。
// 只有包装上印的 use-by 才算数：估算日期只是猜的，过了也只提醒，不当硬事实。
export function isSpoiled(batch, today) {
  return !!(
    batch &&
    hasStock(batch) &&
    batch.date &&
    batch.dateType === "use_by" &&
    batch.dateSource !== "estimate" &&
    batch.date < today
  );
}

// 冰箱里已经坏掉、还没扔的批次（「一键优化」会提议顺手扔掉的就是这些）
export function spoiledBatches(data, today) {
  return (data.inventoryBatches || [])
    .filter((b) => isSpoiled(b, today))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// 一道菜「最晚哪天做」：
//   hard = 用得到的库存里最早的 use_by（包装日期）
//   soft = 用得到的库存里最早的 best_before / 估算日期
// 已经过期的批次不算期限（那是「没了」，不是「快到期」），由 spoiledFor 负责。
export function dishDeadline(recipe, { foodsById, batchesByFood, today }) {
  const per = new Map();
  for (const ing of (recipe && recipe.ingredients) || []) {
    const food = foodsById.get(ing.foodId);
    if (!food || food.area === "seasoning") continue; // 调料放得久，不参与排期
    for (const b of batchesByFood.get(ing.foodId) || []) {
      if (!hasStock(b) || !b.date || b.dateType === "unknown") continue;
      if (b.date < today) continue;
      const hard = b.dateType === "use_by" && b.dateSource !== "estimate";
      const cur = per.get(ing.foodId);
      if (!cur || b.date < cur.date) per.set(ing.foodId, { name: food.name, date: b.date, hard });
      else if (b.date === cur.date && hard) cur.hard = true;
    }
  }
  let hard = null;
  let soft = null;
  const hardFoods = [];
  const softFoods = [];
  for (const x of per.values()) {
    if (x.hard) {
      if (!hard || x.date < hard) {
        hard = x.date;
        hardFoods.length = 0;
      }
      if (x.date === hard) hardFoods.push(x.name);
    } else {
      if (!soft || x.date < soft) {
        soft = x.date;
        softFoods.length = 0;
      }
      if (x.date === soft) softFoods.push(x.name);
    }
  }
  return { hard, soft, due: hard || soft, hardFoods, softFoods };
}

// 这道菜的主料是不是已经全坏了：冰箱里只剩过期的（use_by 包装日期），
// 一点能用的都不剩。这种菜排在哪天都做不成，得换掉（或者去买新的）。
export function spoiledFor(recipe, { foodsById, batchesByFood, today }) {
  const bad = [];
  for (const ing of (recipe && recipe.ingredients) || []) {
    const food = foodsById.get(ing.foodId);
    if (!food || food.area === "seasoning") continue;
    const list = (batchesByFood.get(ing.foodId) || []).filter(hasStock);
    const spoiled = list.filter((b) => isSpoiled(b, today));
    if (!spoiled.length) continue;
    const usable = list.filter((b) => !isSpoiled(b, today));
    if (!usable.length) bad.push({ foodId: ing.foodId, name: food.name, date: spoiled[0].date });
  }
  return bad;
}

export function optimizeWeek(data, { range, today, servings, budgetPence, fillEmpty = true, rescue = true } = {}) {
  const target = servings || (data.settings && data.settings.household ? data.settings.household.defaultServings : 2);
  const budget = budgetPence == null ? data.settings.budget.weeklyPence : budgetPence;
  const foodsById = new Map((data.foods || []).map((f) => [f.id, f]));
  const recipesById = new Map((data.recipes || []).map((r) => [r.id, r]));
  const batchesByFood = new Map();
  for (const b of data.inventoryBatches || []) {
    if (!batchesByFood.has(b.foodId)) batchesByFood.set(b.foodId, []);
    batchesByFood.get(b.foodId).push(b);
  }
  const ctx = { foodsById, batchesByFood, today };
  const deadlineOf = (recipeId) => {
    const r = recipesById.get(recipeId);
    return r ? dishDeadline(r, ctx) : { hard: null, soft: null, due: null, hardFoods: [], softFoods: [] };
  };
  const pool = buildRecipePool(data, { servings: target, today });
  const poolById = new Map(pool.map((p) => [p.recipeId, p]));
  // 主料全坏了的菜不参与「补位」：它这次做不成，别又给排回来
  const brokenIds = new Set();
  for (const r of data.recipes || []) if (spoiledFor(r, ctx).length) brokenIds.add(r.id);

  // ---- 1. 分天：今天以前的不动；今天及以后只认「还没做」的和空白的 ----
  const days = (range && range.days) || [];
  const pastDays = days.filter((d) => d < today);
  const openSlots = []; // {date, meal, state}
  const locked = []; // 外食 / 跳过 / 吃剩菜 / 已做完：不碰
  for (const d of days) {
    if (d < today) continue;
    const meal = (data.meals || []).find((m) => m.date === d) || null;
    const state = meal ? meal.state : null;
    if (!meal || COOKING_STATES.includes(state)) openSlots.push({ date: d, meal, state });
    else locked.push({ date: d, meal, state });
  }

  const lockedIds = new Set(locked.filter((s) => s.meal && s.meal.recipeId).map((s) => s.meal.recipeId));
  const assign = new Map(openSlots.map((s) => [s.date, null])); // 日期 -> 这道菜（null = 空着）
  const slotState = new Map(openSlots.map((s) => [s.date, s.meal && s.meal.recipeId ? "planned" : "orig-empty"]));
  const events = new Map(); // 日期 -> {kind, from, reasons[]}
  const stalePlan = []; // 原来排的菜已经不在可用食谱里（删了 / 还没补全）

  const note = (date, ev) => {
    const cur = events.get(date);
    if (!cur) {
      events.set(date, { kind: ev.kind, from: ev.from || null, reasons: ev.reason ? [ev.reason] : [] });
      return;
    }
    // override：这天「原来的菜挪走了、又补了一道新的」，主体是新的那道
    if (ev.override || KIND_RANK[ev.kind] > KIND_RANK[cur.kind]) {
      cur.kind = ev.kind;
      if (ev.from) cur.from = ev.from;
    }
    if (ev.reason) cur.reasons.push(ev.reason);
  };

  const asCand = (p, extra) => ({
    recipeId: p.recipeId,
    name: p.name,
    category: p.category,
    cost: p.cost,
    reliableCost: p.reliableCost,
    score: p.score,
    covered: p.covered,
    warnHit: p.warnHit,
    warnUsed: p.warnUsed,
    missing: p.missing,
    home: null,
    servings: target,
    hard: null,
    soft: null,
    due: null,
    hardFoods: [],
    softFoods: [],
    ...extra
  });

  // ---- 2. 先看现在这一周都排了什么 ----
  const planned = [];
  for (const s of openSlots) {
    const meal = s.meal;
    if (!meal || !meal.recipeId) continue;
    const p = poolById.get(meal.recipeId);
    const r = recipesById.get(meal.recipeId);
    if (!p) {
      stalePlan.push({ date: s.date, recipeId: meal.recipeId, name: r ? r.name : meal.recipeId });
      slotState.set(s.date, "needs-dish");
      note(s.date, {
        kind: "replace",
        from: { date: s.date, recipeId: meal.recipeId, name: r ? r.name : meal.recipeId },
        reason: r ? "这道菜已经不在可推荐的食谱里（被删了 / 还是草稿），重新排一道" : "原来的食谱找不到了，重新排一道"
      });
      continue;
    }
    const dl = deadlineOf(p.recipeId);
    const cand = asCand(p, {
      home: s.date,
      servings: meal.actualServings != null ? meal.actualServings : target,
      origin: "planned",
      hard: dl.hard,
      soft: dl.soft,
      due: dl.due,
      hardFoods: dl.hardFoods,
      softFoods: dl.softFoods
    });
    assign.set(s.date, cand);
    planned.push(cand);
  }

  const assignedIds = () => {
    const ids = new Set(lockedIds);
    for (const c of assign.values()) if (c) ids.add(c.recipeId);
    return ids;
  };
  const placedIds = new Set();

  // 把某天的菜往前挪：优先对调（occupant 挪回 c.home），其次空白天。
  // 只往 c.due 那天或更早挪。
  const findTarget = (c, { swapWith = "free" } = {}) => {
    const eligible = [...assign.keys()].filter((d) => d !== c.home && (!c.due || d <= c.due));
    for (let i = eligible.length - 1; i >= 0; i -= 1) {
      const d = eligible[i];
      const occ = assign.get(d);
      if (!occ) return { date: d, occupant: null };
      if (placedIds.has(occ.recipeId)) continue; // 已经由这次优化放好的，别再搬
      if (occ.home !== d) continue;
      if (c.home == null) continue; // 过期的菜没有「原来的天」可以还给对方
      if (swapWith === "zero" && (occ.hard || occ.soft)) continue; // 抢救/软期限只动完全没有期限压力的
      if (occ.hard && occ.hard < c.home) continue; // 对调之后对面会迟到，那就算了
      return { date: d, occupant: occ };
    }
    return null;
  };

  // 落位：返回实际上把哪道菜放到了哪天（对调时对方也跟着落位）
  const place = (c, target, reason) => {
    const { date: t, occupant } = target;
    assign.set(t, c);
    placedIds.add(c.recipeId);
    if (occupant) {
      assign.set(c.home, occupant);
      placedIds.add(occupant.recipeId);
      note(t, { kind: "swap", from: { date: c.home, name: c.name }, reason });
      note(c.home, {
        kind: "swap",
        from: { date: t, name: occupant.name },
        reason: `跟 ${md(t)} 的「${c.name}」对调`
      });
      return;
    }
    assign.set(c.home, null);
    slotState.set(c.home, "vacated");
    note(t, { kind: "move", from: { date: c.home, name: c.name }, reason });
    note(c.home, {
      kind: "move",
      from: { date: t, name: c.name },
      reason: `这天的菜挪到 ${md(t)} 去了`
    });
  };

  const why = (c, tier) => {
    const foods = tier === "hard" ? c.hardFoods : c.softFoods;
    const date = tier === "hard" ? c.hard : c.soft;
    const kind = tier === "hard" ? "use-by" : "到期日";
    const from = c.home ? `原定 ${md(c.home)}，` : "";
    return `${from}${foods.join("、")} 的 ${kind} 是 ${md(date)}，排在那之后就坏了`;
  };

  // ---- 3. 主料已经坏了的菜：做不成了，先腾出位置换掉 ----
  for (const c of planned) {
    const r = recipesById.get(c.recipeId);
    const bad = spoiledFor(r, ctx);
    if (!bad.length) continue;
    assign.set(c.home, null);
    placedIds.delete(c.recipeId);
    slotState.set(c.home, "needs-dish");
    note(c.home, {
      kind: "replace",
      from: { date: c.home, recipeId: c.recipeId, name: c.name },
      reason: `${bad.map((b) => b.name).join("、")} 已经坏了（use-by ${md(bad[0].date)}），这道做不成，换一道`
    });
  }

  // ---- 4. 硬期限来不及的：往前挪（对调优先）；实在挪不动才换菜 ----
  const hardLate = planned
    .filter((c) => c.hard && c.home && c.hard < c.home && assign.get(c.home) === c)
    .sort((a, b) => (a.hard < b.hard ? -1 : a.hard > b.hard ? 1 : 0));
  for (const c of hardLate) {
    const target = findTarget(c);
    if (target) {
      place(c, target, `提前：${why(c, "hard")}`);
      continue;
    }
    assign.set(c.home, null);
    placedIds.delete(c.recipeId);
    slotState.set(c.home, "needs-dish");
    note(c.home, {
      kind: "replace",
      from: { date: c.home, recipeId: c.recipeId, name: c.name },
      reason: `${why(c, "hard")}，这周挪不出更早的位置，换一道`
    });
  }

  // ---- 5. 软期限（best-before / 估算日期）尽量提前：只占空白天，或跟毫无期限压力的菜对调 ----
  const softLate = planned
    .filter((c) => !c.hard && c.soft && c.home && c.soft < c.home && assign.get(c.home) === c)
    .sort((a, b) => (a.soft < b.soft ? -1 : a.soft > b.soft ? 1 : 0));
  for (const c of softLate) {
    const target = findTarget(c, { swapWith: "zero" });
    if (target) place(c, target, `尽量提前：${why(c, "soft")}`);
  }

  // ---- 6. 今天以前没做成的菜：还能吃就顺到后面去，别浪费 ----
  const overdue = [];
  for (const d of pastDays) {
    const meal = (data.meals || []).find((m) => m.date === d);
    if (!meal || !meal.recipeId || !COOKING_STATES.includes(meal.state)) continue;
    const p = poolById.get(meal.recipeId);
    const r = recipesById.get(meal.recipeId);
    if (!r) continue;
    const bad = spoiledFor(r, ctx);
    if (bad.length) {
      overdue.push({ date: d, meal, name: r.name, action: "spoiled", bad });
      continue;
    }
    if (!p || lockedIds.has(p.recipeId)) {
      overdue.push({ date: d, meal, name: r.name, action: "left" });
      continue;
    }
    const dl = deadlineOf(p.recipeId);
    if (dl.hard && dl.hard < today) {
      overdue.push({ date: d, meal, name: r.name, action: "spoiled", bad: [{ name: dl.hardFoods.join("、"), date: dl.hard }] });
      continue;
    }
    overdue.push({
      date: d,
      meal,
      name: r.name,
      action: "left",
      cand: asCand(p, {
        home: null,
        servings: meal.actualServings != null ? meal.actualServings : target,
        origin: "overdue",
        hard: dl.hard,
        soft: dl.soft,
        due: dl.due,
        hardFoods: dl.hardFoods,
        softFoods: dl.softFoods
      })
    });
  }
  const movedPast = [];
  // 没做成的菜往哪儿放：只占空白天，不去挤别人已经排好的（想换可以自己在「本周」拖动对调）。
  // 硬期限是硬约束；best-before 那种软期限只在有得挑的时候照顾一下 —— 排在软期限之后
  // 意味着可能得补买新鲜的，但总比这顿白排了强。
  const findHomeForOverdue = (c) => {
    const empty = [...assign.keys()].filter((d) => !assign.get(d) && (!c.hard || d <= c.hard));
    if (!empty.length) return null;
    const inTime = c.due ? empty.filter((d) => d <= c.due) : [];
    const usable = inTime.length ? inTime : empty; // 有得挑就照顾软期限，没有就只能往后放
    return usable[usable.length - 1];
  };
  for (const o of overdue) {
    if (!o.cand) continue;
    const target = findHomeForOverdue(o.cand);
    if (!target) continue;
    assign.set(target, o.cand);
    placedIds.add(o.cand.recipeId);
    note(target, {
      kind: "new",
      reason: `${md(o.date)} 没做成的「${o.name}」顺到这天，别浪费`
    });
    o.action = "moved";
    o.to = target;
    movedPast.push(o.date);
  }

  // ---- 7. 补空：被换掉的天一定要补；本来空着的天看你要不要排满 ----
  const mustFill = new Set(
    [...slotState.entries()].filter(([d, st]) => st === "needs-dish" && assign.get(d) == null).map(([d]) => d)
  );
  const fillDays = [...assign.keys()].filter((d) => assign.get(d) == null && (mustFill.has(d) || fillEmpty));
  const pickFor = (d) => {
    const used = assignedIds();
    let best = null;
    let bestKey = -Infinity;
    for (const p of pool) {
      if (used.has(p.recipeId) || brokenIds.has(p.recipeId)) continue;
      const dl = deadlineOf(p.recipeId);
      if (dl.hard && dl.hard < d) continue; // 硬期限已经来不及的，不排
      // 这几天就要到期的食材优先（顺手消耗）；排在软期限之后的降一点分（品质会差）
      const urgency = dl.soft && dl.soft <= addDaysLocal(d, RESCUE_DAYS) ? 1 : 0;
      const stale = dl.soft && dl.soft < d ? 1 : 0;
      const key = p.score + urgency * 8 - stale * 15;
      if (key > bestKey) {
        bestKey = key;
        best = { p, dl };
      }
    }
    return best;
  };
  for (const d of fillDays) {
    const best = pickFor(d);
    const prev = events.get(d);
    if (!best) {
      note(d, { kind: prev && prev.kind !== "keep" ? prev.kind : "empty", reason: "没有合适的菜可以排" });
      continue;
    }
    const cand = asCand(best.p, {
      home: d,
      origin: "new",
      hard: best.dl.hard,
      soft: best.dl.soft,
      due: best.dl.due,
      hardFoods: best.dl.hardFoods,
      softFoods: best.dl.softFoods
    });
    assign.set(d, cand);
    placedIds.add(cand.recipeId);
    if (prev && prev.kind === "replace") {
      // 「被换掉」的原因已经写好了，新菜名由这一天的结果带出来
      continue;
    }
    // 这天的菜挪走了、又补一道新的：主体算「新排的」，别让用户以为还是原来那道
    const vacated = prev && prev.kind === "move";
    note(d, {
      kind: "new",
      override: vacated,
      from: vacated && prev.from ? { date: prev.from.date, name: prev.from.name } : null,
      reason:
        slotState.get(d) === "orig-empty"
          ? "这天本来空着，排一道用得上冰箱现成食材的"
          : prev && prev.from
            ? `「${prev.from.name}」挪到 ${md(prev.from.date)} 去了，补一道用得上冰箱现成食材的`
            : "补一道用得上冰箱现成食材的"
    });
  }

  // ---- 8. 预算：超了就把最贵的换成更便宜的（不破坏期限） ----
  const mealsNow = (drop) => {
    const dropSet = new Set(drop);
    const out = (data.meals || []).filter((m) => !dropSet.has(m.date) && !assign.has(m.date));
    for (const [date, c] of assign) {
      if (!c) continue;
      out.push({
        id: `meal_${date}_dinner`,
        date,
        slot: "dinner",
        state: "planned",
        recipeId: c.recipeId,
        actualServings: c.servings,
        servingsConfirmed: true
      });
    }
    return out;
  };
  const estimateOf = (drop) =>
    buildShoppingList({
      meals: mealsNow(drop),
      recipes: data.recipes,
      foods: data.foods,
      batches: data.inventoryBatches,
      range,
      stores: data.settings.stores
    });
  const drop = [...movedPast];
  for (let guard = 0; guard < 20; guard += 1) {
    const est = estimateOf(drop).budget.estimatedPence;
    if (est <= budget) break;
    const entries = [...assign.entries()].filter(([, c]) => c);
    if (!entries.length) break;
    const [day, victim] = entries.sort((a, b) => b[1].cost - a[1].cost)[0];
    const used = assignedIds();
    const alt = pool
      .filter((p) => !used.has(p.recipeId) && !brokenIds.has(p.recipeId) && p.reliableCost && p.cost < victim.cost)
      .map((p) => ({ p, dl: deadlineOf(p.recipeId) }))
      .filter(({ dl }) => !dl.hard || dl.hard >= day)
      .sort((a, b) => b.p.score - a.p.score)[0];
    if (!alt) break;
    const cand = asCand(alt.p, {
      home: day,
      origin: "new",
      hard: alt.dl.hard,
      soft: alt.dl.soft,
      due: alt.dl.due,
      hardFoods: alt.dl.hardFoods,
      softFoods: alt.dl.softFoods
    });
    assign.set(day, cand);
    if (estimateOf(drop).budget.estimatedPence >= est) {
      assign.set(day, victim); // 换了没便宜下来，就别折腾
      break;
    }
    placedIds.add(alt.p.recipeId);
    note(day, {
      kind: "replace",
      from: { date: day, recipeId: victim.recipeId, name: victim.name },
      reason: `超预算：把 ${victim.name} 换成便宜一点的 ${alt.p.name}`
    });
  }

  // ---- 9. 顺手抢救：这几天到期、但一周里没人用得上的食材 ----
  const rescueNotes = [];
  if (rescue) {
    const usesFood = (cand, foodId) => {
      const r = recipesById.get(cand.recipeId);
      return !!(r && r.ingredients.some((i) => i.foodId === foodId));
    };
    const soonFoods = [];
    for (const [foodId, list] of batchesByFood) {
      const food = foodsById.get(foodId);
      if (!food || food.area === "seasoning") continue;
      const soon = list
        .filter((b) => hasStock(b) && b.date && b.dateType !== "unknown" && b.date >= today)
        .map((b) => ({ b, info: expiryInfo(b, today) }))
        .filter((x) => x.info.level === "soon")
        .sort((a, b) => (a.b.date < b.b.date ? -1 : 1))[0];
      if (!soon) continue;
      const inPlan = [...assign.values()].some((c) => c && usesFood(c, foodId));
      if (inPlan) continue;
      const recipe = pool
        .filter((p) => !assignedIds().has(p.recipeId) && !brokenIds.has(p.recipeId))
        .map((p) => ({ p, r: recipesById.get(p.recipeId), dl: deadlineOf(p.recipeId) }))
        .filter(({ r }) => r && r.ingredients.some((i) => i.foodId === foodId))
        .sort((a, b) => b.p.score - a.p.score)[0];
      if (!recipe) continue;
      soonFoods.push({ foodId, name: food.name, date: soon.b.date, recipe: recipe.p, dl: recipe.dl });
    }
    for (const item of soonFoods.slice(0, RESCUE_MAX)) {
      // 被换掉的那道：必须完全没有期限压力（不然就是拆东墙补西墙）
      const victims = [...assign.entries()]
        .filter(([d, c]) => c && c.home === d && !c.hard && !c.soft && (!item.dl.hard || item.dl.hard >= d))
        .sort((a, b) => a[1].score - b[1].score);
      const victim = victims[0];
      if (!victim) continue;
      const [day, old] = victim;
      if (item.recipe.score <= old.score + RESCUE_MARGIN) continue;
      assign.set(
        day,
        asCand(item.recipe, {
          home: day,
          origin: "new",
          hard: item.dl.hard,
          soft: item.dl.soft,
          due: item.dl.due,
          hardFoods: item.dl.hardFoods,
          softFoods: item.dl.softFoods
        })
      );
      placedIds.add(item.recipe.recipeId);
      note(day, {
        kind: "replace",
        from: { date: day, recipeId: old.recipeId, name: old.name },
        reason: `顺手消耗：${item.name} ${md(item.date)} 到期，这周没有菜用得上，换成 ${item.recipe.name}`
      });
      rescueNotes.push(`${item.name}（${md(item.date)} 到期）`);
    }
  }

  // ---- 10. 汇总：结果 + 每一处改动的原因 ----
  const list = estimateOf(drop);
  const out = [];
  for (const d of [...assign.keys()].sort()) {
    const c = assign.get(d);
    const ev = events.get(d);
    out.push({
      date: d,
      recipeId: c ? c.recipeId : null,
      name: c ? c.name : null,
      category: c ? c.category : "",
      servings: c ? c.servings : target,
      cost: c ? c.cost : 0,
      hard: c ? c.hard : null,
      soft: c ? c.soft : null,
      due: c ? c.due : null,
      dueFoods: c ? [...c.hardFoods, ...c.softFoods] : [],
      covered: c ? c.covered : 0,
      warnHit: c ? c.warnHit : 0,
      kind: ev ? ev.kind : c ? "keep" : "empty",
      from: ev ? ev.from : null,
      reasons: ev ? ev.reasons : []
    });
  }
  const counts = { keep: 0, move: 0, swap: 0, replace: 0, new: 0, empty: 0 };
  for (const row of out) counts[row.kind] = (counts[row.kind] || 0) + 1;

  const spoiled = spoiledBatches(data, today).map((b) => {
    const f = foodsById.get(b.foodId);
    return {
      batchId: b.id,
      foodId: b.foodId,
      name: f ? f.name : b.foodId,
      date: b.date,
      quantity: b.quantity,
      unit: b.unit
    };
  });
  // 按估算日期已经过期、可包装上没印日期的：不能替你判断还能不能吃，
  // 但得摆出来（「排骨坏了」这种事，用户心里其实清楚，只是缺个提示）。
  const suspect = (data.inventoryBatches || [])
    .filter((b) => hasStock(b) && b.date && b.dateType === "use_by" && b.dateSource === "estimate" && b.date < today)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((b) => {
      const f = foodsById.get(b.foodId);
      return { batchId: b.id, foodId: b.foodId, name: f ? f.name : b.foodId, date: b.date, quantity: b.quantity, unit: b.unit };
    });
  const changed = out.filter((r) => r.kind !== "keep" && r.kind !== "empty");
  const noteText = list.budget.unpricedCount
    ? `其中 ${list.budget.unpricedCount} 项还没有参考价，金额不准`
    : list.budget.estimatedPence > budget
      ? `预计超预算 ${((list.budget.estimatedPence - budget) / 100).toFixed(2)} 英镑`
      : "";

  return {
    today,
    range,
    days: out,
    changes: changed,
    counts,
    changedCount: changed.length,
    locked: locked.map((s) => ({
      date: s.date,
      state: s.state,
      recipeId: s.meal.recipeId || null,
      name: s.meal.recipeId && recipesById.get(s.meal.recipeId) ? recipesById.get(s.meal.recipeId).name : null
    })),
    past: overdue,
    movedPastDates: movedPast,
    stalePlan,
    spoiled,
    suspect,
    // 今天及以后还有没有「可以重排」的天：没有的话界面要说清楚，别假装排好了
    openDays: [...assign.keys()].sort(),
    purgeBatchIds: spoiled.map((s) => s.batchId),
    rescueNotes,
    estimatePence: list.budget.estimatedPence,
    budgetPence: budget,
    unpricedCount: list.budget.unpricedCount,
    overBudget: list.budget.estimatedPence > budget,
    note: noteText,
    // 落地用：日期 -> 菜；null 表示这天要清空
    assignments: Object.fromEntries([...assign.entries()].map(([d, c]) => [d, c ? { recipeId: c.recipeId, servings: c.servings } : null])),
    dropMealDates: drop
  };
}

function addDaysLocal(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
