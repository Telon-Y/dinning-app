import { esc } from "./ui.js?v=4d701ad";
import { formatPence, budgetBar } from "../src/rules/money.js?v=4d701ad";
import { weekRange, todayISO, weekdayIndex, weekStartISO, WEEKDAY_LABEL } from "../src/rules/week.js?v=4d701ad";
import { buildShoppingList, recipeCostPence } from "../src/rules/planning.js?v=4d701ad";
import { expiryInfo, expiryLabel, sortByExpiry, expiringBatches, hasStock } from "../src/rules/expiry.js?v=4d701ad";
import { suggestRecipes } from "../src/rules/suggest.js?v=4d701ad";
import { isMealDish } from "../src/rules/mealtags.js?v=4d701ad";
import { browseRecipes, RECIPE_CATEGORIES } from "../src/rules/browse.js?v=4d701ad";
import { unitPriceText } from "../src/rules/prices.js?v=4d701ad";
import { cookedEvents, cookedDatesByRecipe, lastCookedBefore, weekHistory, monthGrid, shiftMonth, monthLabel } from "../src/rules/history.js?v=4d701ad";

const AREA_LABEL = {
  meat: "🥩 肉类",
  fish: "🐟 水产",
  veg: "🥬 蔬菜",
  fruit: "🍎 水果",
  dairy: "🧈 乳制品与蛋",
  staple: "🍚 主食与干货",
  seasoning: "🧂 调料",
  other: "📦 其他（水 · 饮料 · 零食）"
};
const LOC_LABEL = { fridge: "冷藏", freezer: "冷冻", pantry: "储物柜", counter: "台面" };
const DATE_LABEL = { use_by: "use-by（食品安全）", best_before: "best-before（品质）", unknown: "日期未确认" };

const FIELD_NAMES = {
  settings: "设置", household: "人数", budget: "预算", stores: "常去超市", minStock: "常备下限",
  weeklyPence: "每周预算", defaultServings: "用餐人数", weekStartsOn: "周起点", timezone: "时区",
  foods: "食材", recipes: "食谱", meals: "餐次", inventoryBatches: "库存", purchases: "购买记录",
  cookLogs: "做饭记录", stockLedger: "库存流水", deletions: "删除标记",
  name: "名称", aliases: "别名", baseUnit: "基础单位", area: "分类", packSizes: "包装规格",
  shelfLifeDays: "保鲜天数", storeHint: "常去店", unitConversions: "单位换算",
  baseServings: "基础份数", ingredients: "食材", steps: "步骤", tags: "标签", status: "状态", source: "来源",
  date: "日期", slot: "餐次", state: "状态", recipeId: "食谱", actualServings: "份数", servingsConfirmed: "份数已确认",
  quantity: "数量", unit: "单位", location: "位置", quantityState: "数量类型", level: "档位",
  dateType: "日期类型", addedAt: "放入日期", opened: "已开封", unitCostPence: "单位成本",
  amountPence: "实付金额", storeId: "采购点", timing: "采购时机", stocked: "已入库", sourceKey: "来源键",
  id: "编号", foodId: "食材", batchId: "库存批次", mealId: "餐次", undoneBy: "撤销标记", consumed: "消耗明细"
};

function shortValue(v) {
  if (v === null) return "（没有／已删除）";
  if (v === undefined) return "（不存在）";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > 70 ? s.slice(0, 70) + "…" : s;
}

function nameOf(data, coll, id) {
  const list = (data && data[coll]) || [];
  const item = list.find((x) => x && x.id === id);
  return item ? item.name || id : null;
}

function describePath(data, path) {
  const parts = String(path || "").split("/").filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const prev = parts[i - 1];
    if (prev === "meals" || prev === "cookLogs") {
      const m = /^meal_(\d{4}-\d{2}-\d{2})/.exec(p);
      out.push(m ? m[1].slice(5) : p.slice(0, 12));
      continue;
    }
    if (prev === "foods" || prev === "purchases" || prev === "inventoryBatches" || prev === "recipes") {
      out.push(nameOf(data, prev, p) || p.slice(0, 12));
      continue;
    }
    out.push(FIELD_NAMES[p] || p);
  }
  return out.join(" › ");
}

function renderConflicts(state) {
  const list = state.conflicts || [];
  if (!list.length) return "";
  return `<section class="card">
    <h2>冲突（${list.length}）</h2>
    <p class="muted">两边改了同一处。选一个保留，全部选完会自动写入远端。</p>
    <ul class="plain-list">
      ${list
        .map(
          (c) => `<li class="conflict-item">
            <div class="shop-main">
              <div class="log-msg">${esc(describePath(state.data, c.path))}</div>
              <div class="shop-sub muted">我的：${esc(shortValue(c.local))}</div>
              <div class="shop-sub muted">远端：${esc(shortValue(c.remote))}</div>
            </div>
            <div class="stepper">
              <button class="mini primary" data-action="resolve-conflict" data-path="${esc(c.path)}" data-choice="local">用我的</button>
              <button class="mini" data-action="resolve-conflict" data-path="${esc(c.path)}" data-choice="remote">用远端的</button>
            </div>
          </li>`
        )
        .join("")}
    </ul>
  </section>`;
}

// 「本周」页在看哪一周：state.weekStart 为空就是本周本身，否则是那一周的起点。
// 采购清单（买菜 Tab）和冰箱里的「本周定了」永远按本周算 —— 买菜是现在要买的东西。
function rangeOf(data, weekStart = null) {
  const budget = data.settings.budget;
  return weekRange(weekStart || todayISO(budget.timezone), budget.weekStartsOn);
}

// 这一周相对本周是第几周，用来写「上周 / 下周 / 3 周后」
function weekLabel(weekStart, curStart) {
  const weeks = Math.round((Date.parse(`${weekStart}T00:00:00Z`) - Date.parse(`${curStart}T00:00:00Z`)) / (7 * 86400000));
  if (weeks === 0) return "本周";
  if (weeks === -1) return "上周";
  if (weeks === 1) return "下周";
  return weeks < 0 ? `${-weeks} 周前` : `${weeks} 周后`;
}

function inWeek(iso, r) {
  return iso >= r.start && iso <= r.end;
}

function expClass(info) {
  if (!info) return "muted";
  if (info.level === "expired") return "exp-expired";
  if (info.level === "soon") return "exp-soon";
  return "muted";
}

export function renderTab(state) {
  // 「我的」是填 Token、做同步的地方，即使还没有数据也必须能进，否则没法初始化。
  if (state.tab === "me") return renderSettings(state);
  if (!state.data) {
    const hasToken = !!(state.config && state.config.token);
    return `<section class="card">
      <h2>还没有数据</h2>
      <p class="muted">${hasToken ? "配置已就绪。点下面按钮，把仓库里的 data.json 拉下来。" : "先填好 Token（私有仓库的访问令牌），再读取远端。"}</p>
      <div class="actions">
        <button class="primary" data-action="sync-read">读取远端</button>
        <button class="secondary" data-action="goto-tab" data-tab="me">去「我的」填 Token</button>
      </div>
      ${state.message ? `<p class="muted">${esc(state.message)}</p>` : ""}
    </section>`;
  }
  switch (state.tab) {
    case "shop":
      return renderShop(state);
    case "recipes":
      return renderRecipes(state);
    case "fridge":
      return renderFridge(state);
    case "me":
      return renderSettings(state);
    default:
      return renderWeek(state);
  }
}

export function renderWeek(state) {
  const data = state.data;
  const r = rangeOf(data, state.weekStart);
  const thisWeek = rangeOf(data);
  const today = todayISO(data.settings.budget.timezone);
  const weekName = weekLabel(r.start, thisWeek.start);
  const isCurrent = r.start === thisWeek.start;
  const isPast = r.end < today;
  const recipesById = new Map(data.recipes.map((x) => [x.id, x]));
  const foodsById = new Map(data.foods.map((x) => [x.id, x]));
  const soon = expiringBatches(data.inventoryBatches, today);
  // 「这道菜上次做是什么时候」：只算真正做过的（历史模块里那份判据），
  // 而且要「这天之前」的那一次 —— 今天做的这顿不算「上次」。
  const cookedDates = cookedDatesByRecipe(cookedEvents(data, { timeZone: data.settings.budget.timezone }));
  const lastHint = (recipeId, date) => {
    const prev = recipeId ? lastCookedBefore(cookedDates.get(recipeId), date) : null;
    return prev ? `<span class="muted"> · 上次 ${prev.slice(5)}</span>` : "";
  };
  const list = buildShoppingList({ meals: data.meals, recipes: data.recipes, foods: data.foods, batches: data.inventoryBatches, range: r, stores: data.settings.stores });
  const paid = data.purchases.filter((p) => inWeek(p.purchasedAt.slice(0, 10), r)).reduce((s, p) => s + (p.amountPence || 0), 0);
  // 已经买进来、但还没填实付价的那几笔：金额算不出来，不能再当成 £0 报「还剩多少」
  // 标了「库存·没花钱」的不算待补价：登记成库存就当免费
  const paidPending = data.purchases.filter(
    (p) => inWeek(p.purchasedAt.slice(0, 10), r) && p.amountPence == null && p.storeId !== "stock"
  ).length;
  const budget = data.settings.budget.weeklyPence;
  // 预算条：已付的钱和「还要买」的预计各占一段 —— 以前只画预计，实际花了多少看不出来
  const paidPence = paid;
  const remainPence = Math.max(0, list.budget.estimatedPence);
  const { spentPence, leftPence, over, paidPct, estimatePct } = budgetBar({
    budgetPence: budget,
    paidPence,
    estimatePence: remainPence
  });
  const moneyBar = `<div class="bar">
    <i class="paid${over ? " over" : ""}" style="width:${paidPct}%"></i>
    <i class="estimate${over ? " over" : ""}" style="width:${estimatePct}%"></i>
  </div>`;

  const days = r.days
    .map((d) => {
      const meal = data.meals.find((m) => m.date === d) || null;
      const isToday = d === today;
      // 拖动/对调：只有「还没做」的天能当起点和落点。
      // 外食 / 跳过 / 吃剩菜 / 已做完是你自己定的，不参与（要说清楚原因，别点了没反应）。
      const mealState = meal ? meal.state : null;
      const isCooking = !meal || mealState === "planned" || mealState === "cooking";
      const holdsDish = !!(meal && meal.recipeId && isCooking);
      const swapFrom = state.swapFrom || null;
      const dishLink = (recipe) =>
        recipe
          ? `<span class="link" data-action="edit-recipe-ingredients" data-id="${esc(recipe.id)}">${esc(recipe.name)}</span>`
          : "（食谱缺失）";
      // 这顿大概花多少钱：按参考价和实际用量折算（缺价的食材单独标出来）
      const dishCost = (recipe, servings) => {
        if (!recipe) return "";
        const cost = recipeCostPence(recipe, data.foods, servings);
        if (cost.pence <= 0 && !cost.unpriced) return "";
        // 点一下就进「这道菜多少钱」的二级页，看每样食材摊了多少钱
        return ` · <span class="link" data-action="dish-price" data-id="${esc(recipe.id)}" data-servings="${servings}">参考 ${formatPence(
          cost.pence
        )}${cost.unpriced ? `（${cost.unpriced} 项无价）` : ""}</span>`;
      };
      const stateButtons = (states) =>
        states
          .map(
            ([state, label]) =>
              `<button class="mini" data-action="set-meal" data-date="${d}" data-state="${state}">${label}</button>`
          )
          .join("");
      let body = '<span class="muted">未安排</span>';
      // 空白日：能一次点完的都摆出来（推荐 / 安排 / 不做了的三种），不用先进二级页
      let actions = `<button class="mini primary" data-action="suggest-day" data-date="${d}">推荐</button>
        <button class="mini" data-action="pick-recipe" data-date="${d}">安排</button>
        ${stateButtons([
          ["eating_out", "外食"],
          ["skipped", "跳过"],
          ["leftovers", "吃剩菜"]
        ])}`;

      if (meal) {
        const recipe = meal.recipeId ? recipesById.get(meal.recipeId) : null;
        if (meal.state === "planned" || meal.state === "cooking") {
          const servings = meal.actualServings != null ? meal.actualServings : data.settings.household.defaultServings;
          body = `<b>${dishLink(recipe)}</b><span class="muted"> · ${servings} 人份${dishCost(recipe, servings)}</span>${lastHint(
            meal.recipeId,
            d
          )}`;
          // 有菜的日子只留最常用的三个，其余收进「不做了…」，免得一排七个按钮
          actions = `
            <button class="mini primary" data-action="cook-meal" data-date="${d}">做完</button>
            <button class="mini" data-action="suggest-day" data-date="${d}">推荐</button>
            <button class="mini" data-action="pick-recipe" data-date="${d}">换</button>
            <button class="mini" data-action="day-actions" data-date="${d}">不做了…</button>`;
        } else if (meal.state === "done") {
          const servings = meal.actualServings != null ? meal.actualServings : data.settings.household.defaultServings;
          body = `<span class="done">已做：${dishLink(recipe)}</span><span class="muted">${dishCost(recipe, servings)}</span>`;
          actions = `<button class="mini" data-action="undo-cook" data-date="${d}">撤销做完</button>
            <button class="mini" data-action="pick-recipe" data-date="${d}">重新安排</button>`;
        } else if (meal.state === "eating_out") {
          body = '<span class="tag">外食</span>';
          actions = `<button class="mini" data-action="pick-recipe" data-date="${d}">改成做菜</button>
            <button class="mini" data-action="suggest-day" data-date="${d}">推荐</button>
            <button class="mini" data-action="day-actions" data-date="${d}">改状态…</button>`;
        } else if (meal.state === "skipped") {
          body = '<span class="muted">跳过</span>';
          actions = `<button class="mini" data-action="pick-recipe" data-date="${d}">改成做菜</button>
            <button class="mini" data-action="suggest-day" data-date="${d}">推荐</button>
            <button class="mini" data-action="day-actions" data-date="${d}">改状态…</button>`;
        } else if (meal.state === "leftovers") {
          body = '<span class="tag">吃剩菜</span>';
          actions = `<button class="mini" data-action="pick-recipe" data-date="${d}">改成做菜</button>
            <button class="mini" data-action="suggest-day" data-date="${d}">推荐</button>
            <button class="mini" data-action="day-actions" data-date="${d}">改状态…</button>`;
        }
      }

      // 对调模式：给能当落点的天一个明确的按钮（点按钮，不会跟「做完 / 换」这些按钮打架）
      let swapRow = "";
      if (swapFrom === d) {
        swapRow = `<div class="swap-row"><button class="mini" data-action="swap-cancel">✕ 取消对调</button></div>`;
      } else if (swapFrom && isCooking) {
        swapRow = `<div class="swap-row"><button class="mini primary" data-action="swap-target" data-date="${d}">⇄ 换到这天</button></div>`;
      }
      const classes = [
        "day-card",
        isToday ? "today" : "",
        holdsDish ? "draggable" : "",
        !isCooking ? "locked" : "",
        swapFrom === d ? "swap-source" : swapFrom && isCooking ? "swap-armed" : ""
      ]
        .filter(Boolean)
        .join(" ");

      return `<div class="${classes}" data-day="${d}" data-drop="${isCooking ? "1" : "0"}"${
        holdsDish ? ` data-drag-handle="${d}"` : ""
      }>
        <div class="day-head"><span class="day-name">${WEEKDAY_LABEL[weekdayIndex(d)]}</span><span class="day-date">${d.slice(5)}</span>${
        isToday ? '<span class="today-tag">今天</span>' : ""
      }<span class="day-head-right">${
        holdsDish
          ? `<button class="drag-grip" data-action="swap-start" data-date="${d}" title="对调这一天">⠿ 换</button>`
          : !isCooking
            ? '<span class="muted lock-note">不动</span>'
            : ""
      }</span></div>
        <div class="day-body">${body}</div>
        ${swapRow}
        <div class="day-actions">${actions}</div>
      </div>`;
    })
    .join("");

  return `
    <section class="card week-nav">
      <div class="row between">
        <button class="mini" data-action="week-prev">‹ 上一周</button>
        <span><b>${r.start.slice(5)} ~ ${r.end.slice(5)}</b> <span class="tag${isCurrent ? " star" : ""}">${weekName}</span></span>
        <button class="mini" data-action="week-next">下一周 ›</button>
      </div>
      ${
        isCurrent
          ? `<p class="muted">想看后面几周、提前把菜排上，点「下一周」。</p>`
          : `<div class="actions"><button class="mini" data-action="week-today">回到本周</button></div>
             <p class="muted">${
               isPast
                 ? "这一周已经过去了：这里只回看/补记，不会再给你推荐或重排。"
                 : `你在提前排 ${weekName}：排好之后到那一周买菜清单会自动跟上。`
             }</p>`
      }
    </section>
    <section class="card">
      <div class="row between"><h2>${isCurrent ? "本周预算" : `${weekName}预算`}</h2><span class="muted">周六 → 周五 · ${r.start.slice(5)} 至 ${r.end.slice(5)}</span></div>
      ${moneyBar}
      <p class="legend muted"><span><i class="dot paid"></i>已付 ${formatPence(paidPence)}</span><span><i class="dot estimate"></i>还要买 ${formatPence(
        remainPence
      )}（预计）</span></p>
      <div class="row budget-row">
        <span>已知合计 <b class="${over ? "over-text" : ""}">${formatPence(spentPence)}</b> / 预算 ${formatPence(budget)}${
          paidPending
            ? ` <button class="mini" data-action="pending-prices">＋${paidPending} 笔待补价 ›</button>`
            : ""
        }</span>
        <span class="${leftPence < 0 ? "over-text" : "muted"}">${
          paidPending
            ? "金额还不确定"
            : leftPence < 0
              ? `超出 ${formatPence(-leftPence)}`
              : `还剩 ${formatPence(leftPence)}`
        }</span>
      </div>
      ${
        paidPending
          ? `<p class="muted">${isCurrent ? "本周" : "这一周"}有 ${paidPending} 笔采购还没填实付金额（库存已经算进去了），预算要等补上价才准。</p>`
          : ""
      }
      ${
        list.budget.unpricedCount
          ? `<p class="muted">还有 <b class="warn">${list.budget.unpricedCount}</b> 项没有参考价（没算进上面的金额）。点每天那道菜后面的「参考 £x」能看到它摊了哪几样。</p>`
          : ""
      }
      <div class="actions">
        ${isPast ? "" : '<button class="mini primary" data-action="optimize-week">一键优化排期</button>'}
        ${isPast ? "" : '<button class="mini" data-action="suggest-week">推荐一周菜单</button>'}
        <button class="mini" data-action="calendar-open">📅 吃的日历</button>
      </div>
      <p class="muted">${
        isPast
          ? "这一周已经过去了：点每天那道菜能看到当时的安排，也能补记「做过了 / 外食 / 跳过」。"
          : `「一键优化排期」会按冰箱里的到期日把${isCurrent ? "这一周" : ` ${weekName}`}重排一遍：快坏的往前提，来不及的换掉；外食 / 跳过 / 已做完的天不动。「吃的日历」留着每周真正吃过什么。`
      }</p>
    </section>
    ${
      soon.length
        ? `<section class="card">
            <h2>快到期（${soon.length}）</h2>
            <p class="muted">先吃这些，点一下可以改日期或删掉。</p>
            <ul class="plain-list">
              ${soon
                .map((b) => {
                  const f = foodsById.get(b.foodId);
                  const info = expiryInfo(b, today);
                  return `<li class="fridge-item fresh-${info.level}" data-action="inv-edit" data-id="${esc(b.id)}">
                    <div class="shop-main">
                      <div class="log-msg">${esc(f ? f.name : b.foodId)} <span class="${expClass(info)}">${esc(expiryLabel(info))}</span></div>
                      <div class="shop-sub muted">${esc(LOC_LABEL[b.location] || b.location)}${b.quantityState === "exact" ? ` · ${esc(String(b.quantity))}${esc(b.unit || "")}` : ""}${b.date ? ` · ${esc(b.date)}` : ""}</div>
                    </div>
                  </li>`;
                })
                .join("")}
            </ul>
          </section>`
        : ""
    }
    ${
      state.swapFrom
        ? `<section class="card swap-banner">
            <b>对调：${WEEKDAY_LABEL[weekdayIndex(state.swapFrom)]} ${state.swapFrom.slice(5)}</b>
            <p class="muted">点另一天的「⇄ 换到这天」就完成对调（拖到空白天就是挪过去）。</p>
            <div class="actions"><button class="mini" data-action="swap-cancel">取消</button></div>
          </section>`
        : ""
    }
    <section class="days">${days}</section>
    <p class="muted drag-hint">按住某天右上角的「⠿ 换」拖动，可以直接跟别的天对调；点它则是「点选对调」模式。</p>`;
}

export function renderShop(state) {
  const data = state.data;
  const r = rangeOf(data);
  const list = buildShoppingList({ meals: data.meals, recipes: data.recipes, foods: data.foods, batches: data.inventoryBatches, range: r, stores: data.settings.stores });
  const storeNames = new Map((data.settings.stores || []).map((s) => [s.id, s.name]));
  const purchasedByFood = new Map();
  for (const p of data.purchases) {
    if (inWeek(p.purchasedAt.slice(0, 10), r)) purchasedByFood.set(p.foodId, p);
  }

  // 「已买」= 本周需求已被库存覆盖，而不是「本周有购买记录」。
  // 否则把库存删掉后，这一项会因为购买记录还在而卡在「已买」里，既不用买也买不了。
  const toBuy = list.items.filter((i) => i.shortfall > 0);
  const bought = list.items.filter((i) => i.shortfall <= 0 && purchasedByFood.has(i.foodId));
  const covered = list.items.filter((i) => i.shortfall <= 0 && !purchasedByFood.has(i.foodId));
  const total = toBuy.length + bought.length;
  const pct = total > 0 ? Math.round((bought.length / total) * 100) : 100;

  const renderRow = (i) => {
    const p = purchasedByFood.get(i.foodId);
    const settled = i.shortfall <= 0;
    const done = settled && !!p;
    const parts = [];
    if (i.available > 0) parts.push(`库存 ${i.available}${i.unit}`);
    parts.push(`缺口 ${i.shortfall}${i.unit}`);
    if (i.packs) parts.push(`买 ${i.packs} × ${i.packLabel || ""}${i.leftover ? ` → 剩 ${i.leftover}${i.unit}` : ""}`);
    if (i.storeId) parts.push(storeNames.get(i.storeId) || i.storeId);
    const price = i.estPence != null ? `约 ${formatPence(i.estPence)}` : "待补价";
    return `<li class="shop-item${done ? " bought" : ""}">
      <input type="checkbox" data-action="buy-item" data-key="${esc(i.key || i.foodId)}" ${done ? "checked disabled" : ""}>
      <div class="shop-main">
        <div class="shop-name">${esc(i.name)} <span class="muted">需 ${i.need}${i.unit}</span></div>
        <div class="shop-sub muted">${esc(parts.join(" · "))} · ${i.estPence != null ? esc(price) : `<span class="warn">${esc(price)}</span>`}</div>
        ${
          i.expiredSkipped
            ? `<div class="shop-sub"><span class="warn">冰箱里有 ${i.expiredSkipped} 批已过 use-by（包装日期），这次用不上</span></div>`
            : ""
        }
        ${
          i.expiresBeforeUse
            ? `<div class="shop-sub"><span class="warn">冰箱里那批按估算日期会在做这顿之前到期（估算，不是包装日期）—— 尽量提前用掉</span></div>`
            : ""
        }
        ${p ? `<div class="shop-sub">${done ? "" : '<span class="warn">本周买过，但库存已不在，需要再买</span> '}<button class="mini" data-action="edit-purchase" data-purchase="${esc(p.id)}">改分量 / 价格</button> <button class="mini danger-mini" data-action="undo-purchase" data-purchase="${esc(p.id)}">撤销</button> <span class="muted">已买 ${p.quantity}${p.unit}${p.amountPence == null ? " · 金额待补全" : " · " + formatPence(p.amountPence)}</span></div>` : ""}
      </div>
    </li>`;
  };

  const groups = new Map();
  for (const it of toBuy) {
    if (!groups.has(it.area)) groups.set(it.area, []);
    groups.get(it.area).push(it);
  }
  const groupHtml = [...groups.entries()]
    .map(([area, items]) => `<div class="list-heading">${AREA_LABEL[area] || area}</div><ul class="plain-list">${items.map(renderRow).join("")}</ul>`)
    .join("");

  const paid = data.purchases.filter((p) => inWeek(p.purchasedAt.slice(0, 10), r)).reduce((s, p) => s + (p.amountPence || 0), 0);
  const budget = data.settings.budget.weeklyPence;
  const overEstimate = list.budget.estimatedPence > budget;
  const overPaid = paid > budget;
  const overNote = overPaid
    ? `已付超出预算 ${formatPence(paid - budget)}`
    : overEstimate
      ? `预计超出预算 ${formatPence(list.budget.estimatedPence - budget)}`
      : "";

  return `
    <section class="card">
      <div class="row between"><h2>买菜清单</h2><span class="muted">已买 ${bought.length} / ${total}</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="row budget-row"><span>预计 <b class="${overEstimate ? "over-text" : ""}">${formatPence(list.budget.estimatedPence)}</b> / 预算 ${formatPence(budget)}</span><span class="${overPaid ? "over-text" : "muted"}">已付 ${formatPence(paid)}</span></div>
      ${overNote ? `<p class="over-line">${overNote}</p>` : ""}
      <p class="muted">勾一下就算买了：生成购买记录并入库，价格可以回头补。</p>
    </section>
    <section class="card">${toBuy.length ? groupHtml : '<p class="muted">本周要买的都买齐了。</p>'}</section>
    ${bought.length ? `<section class="card"><div class="list-heading">已买</div><ul class="plain-list">${bought.map(renderRow).join("")}</ul></section>` : ""}
    ${covered.length ? `<section class="card"><div class="list-heading">已有库存，不用买</div><ul class="plain-list">${covered.map((i) => `<li class="shop-item"><div class="shop-main"><div class="shop-name">${esc(i.name)} <span class="muted">需 ${i.need}${i.unit} · 库存 ${i.available}${i.unit}</span></div></div></li>`).join("")}</ul></section>` : ""}
    ${list.warnings.length ? `<section class="card"><div class="list-heading">注意</div>${list.warnings.map((w) => `<p class="muted">${esc(w)}</p>`).join("")}</section>` : ""}`;
}

export function renderRecipes(state) {
  const data = state.data;
  const drafts = data.recipes.filter((r) => r.status === "draft");
  const done = data.recipes.filter((r) => r.status !== "draft");
  const q = (state.recipeQuery || "").trim();
  const curCat = state.recipeCategory || "";
  const limit = state.recipeLimit || 30;
  const { items: shown, total: matchedCount } = browseRecipes(done, { query: q, category: curCat, limit });
  const chips = [
    `<button class="chip${curCat ? "" : " active"}" data-action="pick-category" data-cat="">全部 <span class="muted">${done.length}</span></button>`,
    ...RECIPE_CATEGORIES.map((c) => {
      const n = done.filter((r) => (r.category || "其他") === c).length;
      if (!n) return "";
      return `<button class="chip${curCat === c ? " active" : ""}" data-action="pick-category" data-cat="${esc(c)}">${esc(c)} <span class="muted">${n}</span></button>`;
    })
  ].join("");

  const draftRows = drafts
    .map((r) => {
      const filled = r.ingredients.length > 0;
      return `<li class="log-item">
        <div class="shop-main">
          <div class="log-msg">${esc(r.name)} <span class="tag draft">待完善</span></div>
          <div class="shop-sub muted">${r.createdAt ? `记于 ${esc(String(r.createdAt).slice(0, 10))} · ` : ""}${
        filled ? `电脑已补全 ${r.ingredients.length} 样食材、${r.steps.length} 个步骤` : "等电脑补全食材和做法"
      }</div>
        </div>
        <div class="stepper">
          ${filled ? `<button class="mini primary" data-action="publish-recipe" data-id="${esc(r.id)}">确认发布</button>` : ""}
          <button class="mini" data-action="open-recipe" data-id="${esc(r.id)}">看</button>
          <button class="mini danger-mini" data-action="delete-recipe" data-id="${esc(r.id)}">删除</button>
        </div>
      </li>`;
    })
    .join("");

  const cards = shown
    .map((r) => {
      const cost = recipeCostPence(r, data.foods, r.baseServings);
      return `<div class="card">
        <div class="row between"><b><span class="link" data-action="edit-recipe-ingredients" data-id="${esc(r.id)}">${esc(r.name)}</span></b></div>
        <div class="muted">${r.baseServings} 人份 · ${r.ingredients.length} 样食材 · 参考成本 ${formatPence(cost.pence)}${cost.unpriced ? `（${cost.unpriced} 项无价）` : ""}</div>
        <div class="tags">${(r.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}${
          isMealDish(r) ? "" : '<span class="tag off">不参与推荐</span>'
        }</div>
        <div class="actions">
          <button class="mini" data-action="open-recipe" data-id="${esc(r.id)}">看做法</button>
          <button class="mini primary" data-action="add-to-week" data-id="${esc(r.id)}">加入本周</button>
        </div>
      </div>`;
    })
    .join("");

  return `
    <section class="card">
      <div class="row between"><h2>食谱库</h2><button class="mini primary" data-action="add-recipe">+ 添加食谱</button></div>
      <p class="muted">共 ${data.recipes.length} 道。手机上记个菜名就行，电脑补全食材和做法后你确认发布。</p>
      <input id="recipe-search" value="${esc(q)}" placeholder="🔍 搜菜名 / 类目 / 标签，比如：鸡、主食、家常菜">
      <div class="chips">${chips}</div>
    </section>
    ${
      drafts.length
        ? `<section class="card">
            <div class="row between">
              <div class="list-heading">待完善（${drafts.length}）</div>
              ${
                drafts.filter((r) => r.ingredients.length > 0).length > 1
                  ? `<button class="mini primary" data-action="publish-all-drafts">全部确认发布</button>`
                  : ""
              }
            </div>
            <ul class="plain-list">${draftRows}</ul>
            <p class="muted">在电脑上补全后，这里会出现「确认发布」。</p>
          </section>`
        : ""
    }
    ${
      done.length
        ? `<div class="list-heading" style="margin-left:4px">${
            `${curCat ? esc(curCat) : "全部"}${q ? ` · 搜索「${esc(q)}」` : ""}：${matchedCount} 道`
          }${matchedCount > shown.length ? `，先显示 ${shown.length} 道` : ""}</div>`
        : ""
    }
    ${cards || (drafts.length ? "" : '<section class="card"><p class="muted">还没有食谱。</p></section>')}
    ${
      matchedCount > shown.length
        ? `<section class="card"><button class="mini primary" data-action="show-more-recipes">显示更多（还有 ${matchedCount - shown.length} 道）</button></section>`
        : ""
    }`;
}

export function renderFridge(state) {
  const data = state.data;
  const today = todayISO(data.settings.budget.timezone);
  const foodsById = new Map(data.foods.map((f) => [f.id, f]));
  // 冰箱里还有货的批次：吃完的（精确库存扣到 0）一律当不存在 ——
  // 页面显示、到期提醒、「还没填参考价」都按这一份算。
  const inFridge = data.inventoryBatches.filter(hasStock);
  const showLimit = 5; // 冰箱页只留 5 条，全部推荐进二级页
  const { items: allSuggestions, total: sugTotal } = suggestRecipes(data, { limit: Math.max(showLimit, 40), today });
  // 本周已经定了的菜，能做的就带星标置顶
  const weekRangeNow = rangeOf(data);
  const STILL_TO_COOK = new Set(["planned", "cooking"]);
  const plannedIds = new Set(
    data.meals
      .filter((m) => m.recipeId && STILL_TO_COOK.has(m.state) && inWeek(m.date, weekRangeNow))
      .map((m) => m.recipeId)
  );
  const suggestions = [...allSuggestions]
    .sort((a, b) => (plannedIds.has(b.recipeId) ? 1 : 0) - (plannedIds.has(a.recipeId) ? 1 : 0))
    .slice(0, showLimit);
  // 库存里有、但没有参考价的食材（只算还在冰箱里的那些，吃完的不算）
  const stockedIds = [...new Set(inFridge.map((b) => b.foodId))];
  // 标记过「库存·没花钱」的食材不催补价：这东西本来就没有价格可言
  const noMoneyFoodIds = new Set((data.purchases || []).filter((p) => p.storeId === "stock").map((p) => p.foodId));
  const noMoneyBatch = (b) => noMoneyFoodIds.has(b.foodId);
  const needPriceIds = new Set(inFridge.filter((b) => !noMoneyBatch(b)).map((b) => b.foodId));
  const unpricedFoods = stockedIds
    .filter((id) => needPriceIds.has(id))
    .map((id) => foodsById.get(id))
    .filter((f) => f && !(f.packSizes || []).some((p) => p.pricePence != null))
    .sort((a, b) => (a.name > b.name ? 1 : -1));
  const sugRows = suggestions
    .map(
      (s) => `<li class="fridge-item" data-action="edit-recipe-ingredients" data-id="${esc(s.recipeId)}">
        <div class="shop-main">
          <div class="log-msg">${plannedIds.has(s.recipeId) ? '<span class="tag star">⭐ 本周定了</span> ' : ""}${esc(
        s.name
      )} <span class="muted">${s.category ? esc(s.category) + " · " : ""}已备 ${s.full}${
        s.partial ? ` + 部分 ${s.partial}` : ""
      } / ${s.full + s.partial + s.missing.length} 样</span></div>
          <div class="shop-sub muted">${
            s.missing.length ? `还缺：${esc(s.missing.map((m) => m.name).join("、"))}` : "食材都齐了"
          }${
            s.missingSeasoning && s.missingSeasoning.length
              ? `${s.missing.length ? "；" : ""}调料可能缺：${esc(s.missingSeasoning.map((m) => m.name).join("、"))}`
              : ""
          }${s.warnUsed.length ? ` · 能顺手用掉：${esc(s.warnUsed.join("、"))}` : ""}</div>
        </div>
        <div class="stepper">
          <button class="mini primary" data-action="add-to-week" data-id="${esc(s.recipeId)}">加入本周</button>
          <button class="mini" data-action="open-recipe" data-id="${esc(s.recipeId)}">做法</button>
        </div>
      </li>`
    )
    .join("");
  // 一条库存 → 界面上一行；同一样食材的多批合成一行显示（数量相加），
  // 点开才是每一批的明细。数据层永远保留每一批，采购/消耗/撤销才对得上账。
  const foodRow = (foodId, list) => {
      const b = list[0];
      const f = foodsById.get(b.foodId);
      const exact = list.filter((x) => x.quantityState === "exact");
      const total = exact.reduce((s, x) => s + (Number(x.quantity) || 0), 0);
      const qty =
        exact.length === list.length
          ? `${Math.round(total * 100) / 100}${b.unit}${list.length > 1 ? `（${list.length} 批）` : ""}`
          : `档位：${b.level || "unknown"}`;
      const priced = !!(f && (f.packSizes || []).some((p) => p.pricePence != null)) || noMoneyBatch(b);
      const pack = f ? (f.packSizes || []).find((p) => p.pricePence != null) : null;
      // 颜色按最快到期的那批算
      const soonest = list
        .map((x) => ({ x, info: expiryInfo(x, today) }))
        .sort((a, c) => (a.info.days == null ? 1 : c.info.days == null ? -1 : a.info.days - c.info.days))[0];
      const info = soonest.info;
      const parts = [];
      parts.push([...new Set(list.map((x) => LOC_LABEL[x.location] || x.location))].join("/"));
      const dated = list.filter((x) => x.date);
      if (dated.length) {
        const earliest = dated.sort((a, c) => String(a.date).localeCompare(String(c.date)))[0];
        const dt = earliest.dateType === "use_by" ? "use-by" : earliest.dateType === "best_before" ? "best-before" : "";
        parts.push(`${esc(dt)} ${esc(earliest.date)}${dated.length > 1 ? " 起" : ""}`);
      }
      parts.push(`<span class="${expClass(info)}">${esc(expiryLabel(info))}</span>`);
      if (info.estimated) parts.push("估算");
      if (list.some((x) => x.opened)) parts.push("已开封");
      if (pack && pack.size > 0) parts.push(`参考 ${unitPriceText(pack.pricePence / pack.size, pack.unit)}`);
      return `<li class="fridge-item fresh-${info.level}" data-action="food-batches" data-food="${esc(foodId)}">
        <div class="shop-main">
          <div class="shop-name">${esc(f ? f.name : b.foodId)} <span class="muted">${qty}</span>${
            priced ? "" : ' <button class="tag todo" data-action="set-ref-price" data-food="' + esc(b.foodId) + '">待补价</button>'
          }</div>
          <div class="shop-sub muted">${parts.join(" · ")}</div>
        </div>
        <button class="mini" data-action="food-batches" data-food="${esc(foodId)}">${
          list.length > 1 ? `${list.length} 批 ›` : "明细 ›"
        }</button>
      </li>`;
  };

  // 库存按类目分组，每组可折叠；组内先按食材合并，再按到期日排
  const AREA_ORDER = ["meat", "fish", "veg", "fruit", "dairy", "staple", "seasoning", "other"];
  const grouped = new Map();
  for (const b of sortByExpiry(inFridge, today)) {
    const f = foodsById.get(b.foodId);
    const area = (f && f.area) || "other";
    if (!grouped.has(area)) grouped.set(area, []);
    grouped.get(area).push(b);
  }
  const byFood = (list) => {
    const map = new Map();
    for (const b of list) {
      if (!map.has(b.foodId)) map.set(b.foodId, []);
      map.get(b.foodId).push(b);
    }
    return [...map.entries()];
  };
  const hidden = state.fridgeHidden || {};
  const rows = [...grouped.entries()]
    .sort((a, b) => AREA_ORDER.indexOf(a[0]) - AREA_ORDER.indexOf(b[0]))
    .map(([area, list]) => {
      const foods = byFood(list);
      const urgent = list.filter((b) => ["expired", "soon"].includes(expiryInfo(b, today).level)).length;
      return `<button class="group-head" data-action="fridge-group" data-area="${esc(area)}">
          <span>${esc(AREA_LABEL[area] || area)} <span class="muted">${foods.length} 样</span></span>
          <span class="muted">${urgent ? `<span class="warn">${urgent} 样快到期/已过期</span> · ` : ""}${hidden[area] ? "▸" : "▾"}</span>
        </button>${
          hidden[area] ? "" : `<ul class="plain-list">${foods.map(([foodId, rows]) => foodRow(foodId, rows)).join("")}</ul>`
        }`;
    })
    .join("");

  return `
    <section class="card">
      <div class="row between"><h2>冰箱</h2><div><button class="mini" data-action="food-prices">食材价格</button> <button class="mini primary" data-action="inv-add">+ 加食材</button></div></div>
      <p class="muted">顺手记一下储备量，买菜清单会自动扣掉这些。</p>
    </section>
    <section class="card">
      <h2>用现有食材能做什么</h2>
      <p class="muted">按冰箱现存的食材挑的（按 ${data.settings.household.defaultServings} 人份算），优先消耗快过期的；点菜名改食材，右侧可以直接加进本周。</p>
      ${
        sugRows
          ? `<ul class="plain-list">${sugRows}</ul>
             <p class="muted">带 ⭐ 的是本周还没做的菜，能做就先把它们做掉，省得食材放着坏。</p>`
          : '<p class="muted">现有食材还凑不出一道菜，先去买菜，或者把冰箱里的量记进来。</p>'
      }
      ${
        sugTotal > showLimit
          ? `<div class="actions"><button class="mini" data-action="all-suggestions">看全部 ${sugTotal} 道推荐</button></div>`
          : ""
      }
    </section>
    <section class="card">${
      unpricedFoods.length
        ? `<p class="muted">有 ${unpricedFoods.length} 样还没填参考价（${unpricedFoods
            .slice(0, 6)
            .map((f) => esc(f.name))
            .join("、")}${unpricedFoods.length > 6 ? "…" : ""}）——填了之后预算和推荐才准。点名字后面的「待补价」就能填，也可以点上面的「食材价格」一次看全。</p>`
        : ""
    }${
      rows
        ? `<div class="row between">
             <p class="legend muted" style="margin:0"><span><i class="dot ok"></i>还新鲜</span><span><i class="dot soon"></i>快到期</span><span><i class="dot expired"></i>已过期</span><span><i class="dot unknown"></i>日期未确认</span></p>
           </div>
           ${
             inFridge.some((b) => !b.date)
               ? `<p class="muted">有 ${inFridge.filter((b) => !b.date).length} 条没填日期（所以是灰的）。
                  <button class="mini" data-action="fill-expiry">按保鲜期一键估算到期日</button></p>`
               : ""
           }
           <ul class="plain-list">${rows}</ul>`
        : '<p class="muted">还没有库存记录。</p>'
    }</section>`;
}

export function renderSettings(state) {
  const data = state.data;
  const c = state.config;
  const servings = data ? data.settings.household.defaultServings : 2;
  const budgetP = data ? data.settings.budget.weeklyPence : 5000;
  const trial = typeof window !== "undefined" && window.__DINNING_STANDALONE__;

  return `
    ${renderConflicts(state)}
    ${
      trial
        ? `<section class="card">
             <h2>试用版</h2>
             <p class="muted">这是一个单文件试用版：食谱库已经内置，所有改动只存在这台设备上，不会同步、也不会传到任何仓库。想长期用的话，建议自己建一个空的私有仓库 + Token 填到下面，数据就跟着你走。</p>
           </section>`
        : ""
    }
    <section class="card">
      <h2>同步</h2>
      <div class="status-row">状态：<b>${esc(state.status)}</b></div>
      ${state.message ? `<p class="muted">${esc(state.message)}</p>` : ""}
      ${state.sha ? `<p class="muted">远端版本：${esc(String(state.sha).slice(0, 10))}</p>` : ""}
      ${data ? `<p class="muted">本地数据：食谱 ${data.recipes.length} · 菜单 ${data.meals.length} · 库存 ${data.inventoryBatches.length} · 购买 ${data.purchases.length}</p>` : ""}
      ${state.conflicts && state.conflicts.length ? `<p class="warn">有 ${state.conflicts.length} 处冲突等待处理（已保留双方）</p>` : ""}
      ${state.pending ? `<p class="warn">有未推送的改动：${esc((state.labels || []).join("；") || "改动")}</p>` : ""}
      <div class="grid2">
        <label>Owner<input id="cfg-owner" value="${esc(c.owner)}"></label>
        <label>Repo<input id="cfg-repo" value="${esc(c.repo)}"></label>
        <label>Branch<input id="cfg-branch" value="${esc(c.branch)}"></label>
        <label>Path<input id="cfg-path" value="${esc(c.path)}"></label>
      </div>
      <label>Token<input id="cfg-token" type="password" value="${esc(c.token)}"></label>
      <div class="actions">
        <button class="secondary" data-action="save-config">保存配置</button>
        <button class="primary" data-action="sync-read">读取远端</button>
        <button class="primary" data-action="sync-write">写入远端</button>
      </div>
    </section>
    <section class="card">
      <h2>操作日志</h2>
      <p class="muted">每次自动写入远端都会留一条记录，可以回到其中任意一版。</p>
      <div class="actions"><button class="secondary" data-action="load-log">${state.log ? "刷新日志" : "加载日志"}</button></div>
      ${
        state.log
          ? state.log.length
            ? `<ul class="plain-list log-list">${state.log
                .map(
                  (c) => `<li class="log-item">
                    <div class="shop-main">
                      <div class="log-msg">${esc(c.message)}</div>
                      <div class="shop-sub muted">${esc((c.date || "").replace("T", " ").slice(0, 16))} · ${esc(c.short)}</div>
                    </div>
                    <button class="mini" data-action="restore-commit" data-sha="${c.sha}">回到这版</button>
                  </li>`
                )
                .join("")}</ul>`
            : `<p class="muted">还没有记录。</p>`
          : ""
      }
    </section>
    <section class="card">
      <h2>备份与恢复</h2>
      <p class="muted">存档会压缩并混淆成一串文本，复制走存好；读档时整段粘贴回来即可。替换数据前，会先把当前数据在本机备份一份。</p>
      <div class="actions">
        <button class="secondary" data-action="make-save">生成存档文本</button>
        <button class="secondary" data-action="load-save">粘贴读档</button>
      </div>
      ${
        state.backup
          ? `<p class="muted">本机备份：${esc(String(state.backup.at || "").replace("T", " ").slice(0, 16))} · ${esc(state.backup.summary)}</p>
             <div class="actions"><button class="mini" data-action="restore-backup">恢复这份备份</button></div>`
          : `<p class="muted">还没有本机备份（读档或恢复时会自动生成）。</p>`
      }
    </section>
    <section class="card">
      <h2>设置</h2>
      <label>用餐人数
        <select id="set-servings">${[1, 2, 3, 4].map((n) => `<option value="${n}"${n === servings ? " selected" : ""}>${n} 人</option>`).join("")}</select>
      </label>
      <label>每周预算（£）<input id="set-budget" type="number" min="0" step="1" value="${(budgetP / 100).toFixed(0)}"></label>
      ${
        (data ? data.settings.stores : []).length
          ? `<div class="list-heading">常去的店</div><ul class="plain-list">${(data.settings.stores || [])
              .map(
                (s) => `<li class="store-row">
                  <span class="ing-name">${esc(s.name)}</span>
                  <select data-store-role="${s.id}">
                    <option value="main"${s.role === "topup" ? "" : " selected"}>大采购</option>
                    <option value="topup"${s.role === "topup" ? " selected" : ""}>顺手补货</option>
                  </select>
                </li>`
              )
              .join("")}</ul>
            <p class="muted">决定买菜清单里这一项算「大采购」还是「顺手补货」，也决定买东西时默认去哪家。</p>`
          : ""
      }
      <div class="actions"><button class="primary" data-action="save-settings">保存设置</button></div>
    </section>`;
}

// 「吃的日历」：月历 + 选中那天 + 那一周。
// 只读，事实源是做饭记录（history.js），所以「排了没做」会标出来，不会当成吃过。
// 周起点、时区都跟着设置走，和「本周」是同一套口径 —— 不然「上周」会有两种说法。
export function calendarBody(state, { month = null, day = null } = {}) {
  const data = state.data;
  const budget = (data.settings && data.settings.budget) || {};
  const tz = budget.timezone || "UTC";
  const weekStartsOn = budget.weekStartsOn || "saturday";
  const today = todayISO(tz);
  const cur = /^\d{4}-\d{2}$/.test(String(month || "")) ? month : today.slice(0, 7);
  const year = Number(cur.slice(0, 4));
  const mon = Number(cur.slice(5, 7));
  const selected = /^\d{4}-\d{2}-\d{2}$/.test(String(day || "")) ? day : today;
  const grid = monthGrid(data, { year, month: mon, weekStartsOn, timeZone: tz, today });
  const events = cookedEvents(data, { timeZone: tz });
  const week = weekHistory(data, { weekStart: weekStartISO(selected, weekStartsOn), weekStartsOn, timeZone: tz, today });

  const DOW = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const startIdx = Math.max(0, DOW.indexOf(weekStartsOn));
  const dows = Array.from({ length: 7 }, (_, i) => WEEKDAY_LABEL[(startIdx + i) % 7]).map((w) => `<div class="cal-dow">${w}</div>`).join("");

  const KIND_SHORT = { eating_out: "外食", skipped: "跳过", leftovers: "剩菜", missed: "没做", planned: "定了", future: "", empty: "", outside: "" };
  const cells = grid.cells
    .map((c) => {
      const cls = ["cal-cell", `cal-${c.kind}`, c.inMonth ? "" : "out-month", c.date === today ? "today" : "", c.date === selected ? "selected" : ""]
        .filter(Boolean)
        .join(" ");
      const label = c.kind === "cooked" ? (c.names[0] || "吃过") + (c.eaten.length > 1 ? ` +${c.eaten.length - 1}` : "") : KIND_SHORT[c.kind] || "";
      const title = c.kind === "cooked" ? c.names.join("、") : KIND_SHORT[c.kind] || "";
      return `<button class="${cls}" data-action="cal-pick" data-date="${c.date}" title="${esc(title)}">
        <span class="cal-num">${c.dayNumber}</span><span class="cal-name">${esc(label)}</span>
      </button>`;
    })
    .join("");

  const timeOf = (iso) =>
    iso
      ? new Intl.DateTimeFormat("zh-CN", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso))
      : "";
  const cookedDates = cookedDatesByRecipe(events);

  const selDay = week.days.find((d) => d.date === selected) || {
    date: selected,
    weekday: WEEKDAY_LABEL[weekdayIndex(selected)],
    kind: "empty",
    eaten: []
  };
  const emptyNote =
    selDay.kind === "eating_out"
      ? "这天外食"
      : selDay.kind === "skipped"
        ? "这天跳过"
        : selDay.kind === "leftovers"
          ? "这天吃剩菜"
          : selDay.kind === "missed"
            ? `这天排了没做${selDay.planned ? `（原定：${esc(selDay.planned.name)}）` : ""}`
            : selDay.kind === "planned"
              ? `这天定的是${selDay.planned ? ` ${esc(selDay.planned.name)}` : "一道菜"}，还没到`
              : selDay.date > today
                ? "还没到这周"
                : "这天没安排";
  const dayRows = selDay.eaten.length
    ? selDay.eaten
        .map((e) => {
          const prev = lastCookedBefore(cookedDates.get(e.recipeId), e.date);
          // 按钮按在这天，但真正下厨可能是另一天（提前做 / 第二天才补记）—— 两个日期都写出来
          const when = e.cookedAt
            ? e.cookedDate && e.cookedDate !== e.date
              ? `${e.cookedDate.slice(5)} ${timeOf(e.cookedAt)} 下的厨，记在 ${e.date.slice(5)} 这顿`
              : `${timeOf(e.cookedAt)} 做的`
            : `按 ${e.date} 这天的排期记的`;
          return `<li class="log-item"><div class="shop-main">
            <div class="log-msg">${esc(e.name || "（这道菜已经找不到了）")}${e.servings ? ` <span class="muted">${e.servings} 人份</span>` : ""}</div>
            <div class="shop-sub muted">${esc(when)} · ${prev ? `上次做：${prev.slice(5)}` : "以前没做过"}</div>
          </div></li>`;
        })
        .join("")
    : `<li class="muted">${emptyNote}</li>`;

  const s = week.stats;
  const parts = [];
  if (s.cooked) parts.push(`做了 ${s.cooked} 顿`);
  if (s.eatingOut) parts.push(`外食 ${s.eatingOut} 天`);
  if (s.skipped) parts.push(`跳过 ${s.skipped} 天`);
  if (s.leftovers) parts.push(`剩菜 ${s.leftovers} 天`);
  if (s.missed) parts.push(`排了没做 ${s.missed} 天`);
  if (s.planned) parts.push(`还没到 ${s.planned} 天`);
  if (s.empty + s.future) parts.push(`没安排 ${s.empty + s.future} 天`);

  const weekRows = week.days
    .map((d) => {
      const what = d.eaten.length
        ? d.eaten.map((e) => esc(e.name || "（找不到的菜）")).join("、")
        : d.kind === "eating_out"
          ? '<span class="tag">外食</span>'
          : d.kind === "skipped"
            ? "跳过"
            : d.kind === "leftovers"
              ? '<span class="tag">吃剩菜</span>'
              : d.kind === "missed"
                ? `<span class="warn">没做</span>${d.planned ? ` <span class="muted">原定 ${esc(d.planned.name)}</span>` : ""}`
                : d.kind === "planned"
                  ? `<span class="muted">${d.planned ? esc(d.planned.name) : "定了菜"}（还没到）</span>`
                  : '<span class="muted">—</span>';
      return `<li class="cal-week-row${d.date === selected ? " selected" : ""}" data-action="cal-pick" data-date="${d.date}"><span class="cal-week-day">${esc(
        d.weekday
      )} ${d.date.slice(5)}</span><span class="cal-week-what">${what}</span></li>`;
    })
    .join("");

  const prevM = shiftMonth(year, mon, -1);
  const nextM = shiftMonth(year, mon, 1);

  return `
    <p class="muted">按你的时区（${esc(tz)}）算「哪天吃的」：只算真正做过的，排了没做会标成「没做」，不会当成吃过。</p>
    <div class="cal-head">
      <button class="mini" data-action="cal-prev">‹ ${esc(monthLabel(prevM.year, prevM.month))}</button>
      <b>${esc(monthLabel(year, mon))}</b>
      <button class="mini" data-action="cal-next">${esc(monthLabel(nextM.year, nextM.month))} ›</button>
      <button class="mini" data-action="cal-today">今天</button>
    </div>
    <div class="cal-grid">${dows}${cells}</div>
    <p class="legend muted"><span><i class="dot ok"></i>做过</span><span><i class="dot soon"></i>外食/跳过</span><span><i class="dot expired"></i>没做</span><span><i class="dot unknown"></i>没安排</span></p>
    <div class="list-heading">${esc(selDay.weekday)} ${selected.slice(5)}</div>
    <ul class="plain-list">${dayRows}</ul>
    <div class="row between">
      <div class="list-heading">这一周 ${week.weekStart.slice(5)} ~ ${week.weekEnd.slice(5)}</div>
      <button class="mini" data-action="cal-goto" data-date="${week.weekStart}">去这一周排 ›</button>
    </div>
    <p class="muted">${parts.join(" · ") || "这周什么都没有"}</p>
    <ul class="plain-list cal-week">${weekRows}</ul>`;
}
