import {
  state,
  init,
  subscribe,
  mutate,
  readRemote,
  writeRemote,
  saveConfig,
  currentRange,
  syncOnOpen,
  loadLog,
  restoreCommit,
  resolveConflictAt,
  exportSaveText,
  importSaveText,
  restoreBackup
} from "./store.js?v=4d701ad";
import { renderTab, calendarBody } from "./views.js?v=4d701ad";
import {
  esc,
  openModal,
  mountModals,
  toast,
  closeModalsOnBack,
  closeModal,
  servingsField,
  readServings,
  bindServings,
  radioRow
} from "./ui.js?v=4d701ad";
import { formatPence } from "../src/rules/money.js?v=4d701ad";
import { foodPriceHistory, unitPriceText, lastKnownPrice } from "../src/rules/prices.js?v=4d701ad";
import { buildPriceBook } from "../src/rules/pricebook.js?v=4d701ad";
import { findSimilarRecipes } from "../src/rules/similar.js?v=4d701ad";
import { suggestWeek, suggestDay, estimateWithPick } from "../src/rules/plan.js?v=4d701ad";
import { optimizeWeek } from "../src/rules/optimize.js?v=4d701ad";
import { shiftMonth } from "../src/rules/history.js?v=4d701ad";
import { missingMealTags } from "../src/rules/mealtags.js?v=4d701ad";
import { browseRecipes, RECIPE_CATEGORIES } from "../src/rules/browse.js?v=4d701ad";
import { buildShoppingList } from "../src/rules/planning.js?v=4d701ad";
import { recipeCostPence, recipeCostBreakdown } from "../src/rules/planning.js?v=4d701ad";
import { weekRange, todayISO, weekdayIndex, WEEKDAY_LABEL, inRange, weekStartISO, shiftWeek } from "../src/rules/week.js?v=4d701ad";
import { suggestRecipes } from "../src/rules/suggest.js?v=4d701ad";
import {
  upsertMeal,
  removeMeal,
  updateSettings,
  addDraftRecipe,
  newBatch,
  upsertBatch,
  removeBatch,
  adjustBatch,
  setPurchasePrice,
  calibratePurchase,
  setFoodPack,
  undoPurchase,
  undoCook,
  publishRecipe,
  removeRecipe,
  updateRecipe,
  applyWeekPlan,
  applyOptimizedWeek,
  swapMealDays
} from "../src/rules/model.js?v=4d701ad";
import { stockInPurchase, cookMeal } from "../src/rules/inventory.js?v=4d701ad";
import { estimateBatchDates, backfillBatchDates, shiftExpiryDate, expiryInfo, expiryLabel, hasStock } from "../src/rules/expiry.js?v=4d701ad";
import { convert, COMMON_UNITS } from "../src/rules/units.js?v=4d701ad";

const view = document.getElementById("view");
const badge = document.getElementById("sync-badge");
const tabbar = document.getElementById("tabbar");

mountModals(document.getElementById("modal-root"));

// 回退键靠历史记录实现：最底下是 kind=home 的那条，上面留一格“栅栏”。
// 每次退到最底层都会把栅栏补回去，所以即使初始登记没生效，也不会一按就退出。
function pushGuard() {
  try {
    history.pushState({ app: true, tab: state.tab, kind: "tab" }, "", "#tab");
  } catch {
    /* 某些环境不允许改历史记录，忽略 */
  }
}

// index.html 头部已经写过一条 home 记录；这里只负责把栅栏补齐
if (!history.state || history.state.kind !== "tab") pushGuard();
window.addEventListener("popstate", onPopState);

// 构建号在发布时注入。页面打开或从后台切回时，若线上版本已变，自动带版本号重载，
// 这样就不用手动往地址后面加 ?v= 了。
const BUILD = (document.querySelector('meta[name="build"]') || {}).content || "dev";

// 版本号就是发布时的 git 短提交号；老的纯时间戳格式也兼容显示。
function formatBuild(stamp) {
  if (stamp === "dev") return "dev";
  if (/^\d{14}$/.test(stamp)) return `v${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}`;
  return `v${stamp}`;
}

(function showBuild() {
  const el = document.getElementById("build-tag");
  if (el) el.textContent = formatBuild(BUILD);
})();

async function checkForUpdate() {
  // 单文件试用版没有"发布"这回事：它的构建号永远对不上 version.txt，
  // 不拦的话每次打开都会多跳一次（多一次白屏）。
  if (typeof window !== "undefined" && window.__DINNING_STANDALONE__) return;
  try {
    const res = await fetch("../version.txt", { cache: "no-store" });
    if (!res.ok) return;
    const latest = (await res.text()).trim();
    if (!latest || latest === BUILD) return;
    const url = new URL(location.href);
    if (url.searchParams.get("v") === latest) return; // 已经在新版上，避免循环
    if (document.querySelector(".modal")) return; // 有弹窗开着，不打断
    if (state.status === "待同步") return; // 有未推送的改动，不丢
    url.searchParams.set("v", latest);
    location.replace(url.toString());
  } catch {
    /* 离线或取不到版本文件就跳过 */
  }
}

const recipesById = () => new Map(state.data.recipes.map((r) => [r.id, r]));
const foodsById = () => new Map(state.data.foods.map((f) => [f.id, f]));

// 「本周」页现在能翻周（可以提前把后面的菜排上）。
// 推荐 / 优化 / 单日推荐都按「正在看的那一周」算；买菜清单和「加入本周」仍然认本周本身。
function viewedWeekStart() {
  return state.weekStart || currentRange(state.data).start;
}

function viewedRange() {
  return weekRange(viewedWeekStart(), state.data.settings.budget.weekStartsOn);
}

function rangeOfDate(date) {
  return weekRange(date, state.data.settings.budget.weekStartsOn);
}

function currentList() {
  return buildShoppingList({
    meals: state.data.meals,
    recipes: state.data.recipes,
    foods: state.data.foods,
    batches: state.data.inventoryBatches,
    range: currentRange(state.data),
    stores: state.data.settings.stores
  });
}

function render() {
  view.innerHTML = renderTab(state);
  for (const b of tabbar.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === state.tab);
  badge.textContent = state.status;
  badge.className = "badge" + (state.statusKind ? " " + state.statusKind : "");
}

function weekOptions(selected) {
  const r = currentRange(state.data);
  return r.days
    .map((d) => `<option value="${d}"${d === selected ? " selected" : ""}>${WEEKDAY_LABEL[weekdayIndex(d)]} ${d.slice(5)}</option>`)
    .join("");
}

// 「安排」的选菜页：把食谱库那套（搜索 + 类目 + 卡片）复刻进来，
// 选中的直接排到这一天，不用再回食谱页找。
let picker = { date: null, query: "", category: "", limit: 30, servings: null };

function openRecipePicker(date, patch = {}) {
  if (picker.date !== date) picker = { date, query: "", category: "", limit: 30, servings: null };
  Object.assign(picker, patch);

  const data = state.data;
  const all = data.recipes.filter((r) => r.status !== "draft");
  if (!all.length) {
    toast("还没有可用的食谱，先去食谱库加一道");
    return;
  }
  const { items, total } = browseRecipes(all, {
    query: picker.query,
    category: picker.category,
    limit: picker.limit,
    preferMeal: true
  });
  const fById = foodsById();
  const meal = data.meals.find((m) => m.id === `meal_${date}_dinner`);
  const cur = meal && meal.recipeId ? recipesById().get(meal.recipeId) : null;
  const servings = picker.servings || (meal && meal.actualServings) || data.settings.household.defaultServings;

  const chips = [
    `<button class="chip${picker.category ? "" : " active"}" data-action="picker-cat" data-cat="">全部 <span class="muted">${all.length}</span></button>`,
    ...RECIPE_CATEGORIES.map((c) => {
      const n = all.filter((r) => (r.category || "其他") === c).length;
      if (!n) return "";
      return `<button class="chip${picker.category === c ? " active" : ""}" data-action="picker-cat" data-cat="${esc(c)}">${esc(c)} <span class="muted">${n}</span></button>`;
    })
  ].join("");

  const cards = items
    .map((r) => {
      const cost = recipeCostPence(r, data.foods, r.baseServings);
      const miss = missingMealTags(r);
      return `<li class="log-item">
        <div class="shop-main">
          <div class="log-msg">${esc(r.name)}${cur && cur.id === r.id ? ' <span class="tag draft">这天就是它</span>' : ""}</div>
          <div class="shop-sub muted">${esc(r.category || "其他")} · ${r.baseServings} 人份 · ${r.ingredients.length} 样食材 · 参考成本 ${formatPence(cost.pence)}${
            cost.unpriced ? `（${cost.unpriced} 项无价）` : ""
          }</div>
          <div class="tags">${(r.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}${
            miss.length ? '<span class="tag off">不参与推荐</span>' : ""
          }</div>
        </div>
        <div class="stepper">
          <button class="mini" data-action="open-recipe" data-id="${r.id}">看做法</button>
          <button class="mini primary" data-action="picker-pick" data-date="${date}" data-recipe="${r.id}">排到这天</button>
        </div>
      </li>`;
    })
    .join("");

  openModal({
    title: `${WEEKDAY_LABEL[weekdayIndex(date)]} ${date.slice(5)} 安排`,
    body: `
      <p class="muted">${cur ? `这天现在是「${esc(cur.name)}」，换一道就点下面的「排到这天」` : "选一道排到这天"}</p>
      <input id="picker-search" value="${esc(picker.query)}" autocomplete="off" placeholder="🔍 搜菜名 / 类目 / 标签，比如：鸡、主食、家常菜">
      <div class="chips">${chips}</div>
      <div class="list-heading">${picker.category ? esc(picker.category) : "全部"}${picker.query ? ` · 搜索「${esc(
        picker.query
      )}」` : ""}：${total} 道${total > items.length ? `，先显示 ${items.length} 道` : ""}</div>
      <ul class="plain-list">${cards || '<li class="muted">没有匹配的菜</li>'}</ul>
      ${
        total > items.length
          ? `<p class="muted"><button class="mini" data-action="picker-more">显示更多</button></p>`
          : ""
      }
      ${servingsField("picker-servings", servings, { max: Math.max(8, servings) })}
      <p class="muted">想留隔天午饭，就把份数调大（比如 2 人吃、这顿做 4 份）。</p>`,
    okText: "关闭",
    onMount: (m) => {
      const box = m.querySelector("#picker-search");
      box.addEventListener("input", () => {
        picker.query = box.value;
        picker.limit = 30;
        openRecipePicker(date);
      });
      bindServings(m, "picker-servings", (v) => {
        picker.servings = v;
      });
    }
  });
}

function addToWeek(recipeId) {
  const r = currentRange(state.data);
  openModal({
    title: "加入本周",
    body: `
      <label>哪天<select id="w-date">${weekOptions(r.days[0])}</select></label>
      ${servingsField("w-servings", state.data.settings.household.defaultServings)}`,
    okText: "加进去",
    onMount: (m) => bindServings(m, "w-servings"),
    onOk: (m) => {
      const date = m.querySelector("#w-date").value;
      const sv = readServings(m, "w-servings", state.data.settings.household.defaultServings);
      mutate((d) => upsertMeal(d, date, { state: "planned", recipeId, actualServings: sv, servingsConfirmed: true }));
      state.tab = "week";
      state.weekStart = null; // 「加入本周」加的是本周：别停在别的一周上
      toast("已加到本周");
    }
  });
}

function openRecipe(recipeId) {
  const r = recipesById().get(recipeId);
  if (!r) return;
  const fById = foodsById();
  const servings = state.data.settings.household.defaultServings;
  const scale = servings / r.baseServings;
  const ings = r.ingredients
    .map((i) => {
      const f = fById.get(i.foodId);
      return `<li>${esc(f ? f.name : i.foodId)} ${Math.round(i.amount * scale * 100) / 100}${i.unit}</li>`;
    })
    .join("");
  const steps = r.steps.map((s) => `<li>${esc(s)}</li>`).join("");
  const isDraft = r.status === "draft";
  const ready = isDraft && r.ingredients.length > 0;
  const missTags = missingMealTags(r);
  openModal({
    title: r.name,
    body: `
      <p class="muted">基准 ${r.baseServings} 人份，按 ${servings} 人份显示${isDraft ? " · 待完善" : ""}</p>
      ${
        isDraft
          ? ""
          : `<p class="muted">${
              missTags.length
                ? `缺「${missTags.join("、")}」标签，不会被推荐`
                : "带「家常菜 + 正餐」，会参与推荐"
            }</p>`
      }
      <div class="list-heading">食材</div><ul>${ings || "<li>还没有食材（等电脑补全）</li>"}</ul>
      <div class="list-heading">做法</div><ol>${steps || "<li>还没有做法（等电脑补全）</li>"}</ol>
      <p class="muted"><button class="mini" data-action="edit-recipe-ingredients" data-id="${r.id}">调整食材 / 标签</button></p>`,
    okText: ready ? "确认并发布" : isDraft ? "关闭" : "加入本周",
    onOk: () => {
      if (ready) {
        mutate((d) => publishRecipe(d, r.id), `发布食谱：${r.name}`);
        toast("已发布，可以排进本周了");
        return;
      }
      if (!isDraft) addToWeek(r.id);
    }
  });
}

function addRecipe() {
  openModal({
    title: "添加食谱",
    body: `
      <label>菜名<input id="r-name" autocomplete="off" data-autofocus placeholder="比如：葱油鸡"></label>
      <div id="r-similar"></div>
      <p class="muted">先只记名字即可，之后在电脑的 agent 里补全食材和做法。</p>`,
    okText: "保存",
    onMount: (m) => {
      const input = m.querySelector("#r-name");
      const box = m.querySelector("#r-similar");
      const paint = () => {
        const name = input.value.trim();
        if (name.length < 2) {
          box.innerHTML = "";
          return;
        }
        const hits = findSimilarRecipes(state.data.recipes, name, { limit: 4 });
        box.innerHTML = hits.length
          ? `<p class="warn">库里已经有相近的，点开看看，别重复建：</p><div class="pick-list">${hits
              .map(
                (h) =>
                  `<button type="button" class="pick" data-open="${h.recipe.id}">${esc(h.recipe.name)}<span class="muted">${
                    h.level === "same" ? "就是这道" : h.level === "close" ? "很接近" : "有点像"
                  }</span></button>`
              )
              .join("")}</div>`
          : "";
      };
      input.addEventListener("input", paint);
      box.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-open]");
        if (btn) openRecipe(btn.dataset.open);
      });
      paint();
    },
    onOk: (m) => {
      const name = m.querySelector("#r-name").value.trim();
      if (!name) {
        toast("菜名不能为空");
        return false;
      }
      const same = findSimilarRecipes(state.data.recipes, name, { limit: 1 }).find((h) => h.level === "same");
      if (same) {
        toast(`已经有「${same.recipe.name}」了`);
        return false;
      }
      mutate((d) => addDraftRecipe(d, name), `新增食谱：${name}`);
      toast("已存为待完善");
      return true;
    }
  });
}

const LOC_CHOICES = [
  ["fridge", "冷藏"],
  ["freezer", "冷冻"],
  ["pantry", "储物柜"],
  ["counter", "台面"]
];
const DTYPE_CHOICES = [
  ["unknown", "日期未确认"],
  ["use_by", "use-by（食品安全）"],
  ["best_before", "best-before（品质）"]
];

function optionsHtml(choices, selected) {
  return choices.map(([v, label]) => `<option value="${v}"${v === selected ? " selected" : ""}>${esc(label)}</option>`).join("");
}

// 单选胶囊：代码里改值的时候连高亮一起改
function setRadio(id, value) {
  const input = document.getElementById(id);
  if (!input) return;
  input.value = value;
  for (const b of input.parentElement.querySelectorAll("[data-radio]")) {
    b.classList.toggle("active", b.dataset.value === value);
  }
}

// 到期日那一块：默认按食材保鲜期估算，也有一键日期；手动改成包装上的日期就按包装算
function dateFields(prefix, { dtype, date, foodId, locSel, addedSel }) {
  return `
    <div class="field">
      <span class="field-label">日期类型</span>
      ${radioRow({ id: `${prefix}-dtype`, value: dtype, choices: DTYPE_CHOICES })}
    </div>
    <label>保质 / 到期日期<input id="${prefix}-date" type="date" value="${esc(date || "")}"
      data-food="${esc(foodId || "")}" data-loc-sel="${locSel}" data-added-sel="${addedSel}"></label>
    <div class="radio-row">
      <button type="button" class="chip" data-action="date-preset" data-target="${prefix}" data-mode="estimate">按保鲜期估算</button>
      <button type="button" class="chip" data-action="date-preset" data-target="${prefix}" data-mode="days" data-days="3">+3 天</button>
      <button type="button" class="chip" data-action="date-preset" data-target="${prefix}" data-mode="days" data-days="7">+1 周</button>
      <button type="button" class="chip" data-action="date-preset" data-target="${prefix}" data-mode="days" data-days="14">+2 周</button>
      <button type="button" class="chip" data-action="date-preset" data-target="${prefix}" data-mode="days" data-days="30">+1 月</button>
    </div>
    <p class="muted" id="${prefix}-date-hint"></p>`;
}

// 按当前食材 / 位置 / 放入日期算出估算到期日，填进去并提示
function fillEstimatedDate(prefix) {
  const dateInput = document.getElementById(`${prefix}-date`);
  if (!dateInput) return;
  const food = foodsById().get(dateInput.dataset.food);
  const loc = dateInput.dataset.locSel ? (document.querySelector(dateInput.dataset.locSel) || {}).value : null;
  const added = dateInput.dataset.addedSel ? (document.querySelector(dateInput.dataset.addedSel) || {}).value : null;
  const est = estimateBatchDates(food, { addedAt: added, location: loc });
  const hint = document.getElementById(`${prefix}-date-hint`);
  if (!food || !est) {
    if (hint) hint.textContent = food ? "这样食材还没设保鲜期，日期只能手填。" : "先选食材，再自动带出到期日。";
    return;
  }
  dateInput.value = est.date;
  dateInput.dataset.source = "estimate";
  setRadio(`${prefix}-dtype`, est.dateType);
  const days = Math.round((Date.parse(`${est.date}T00:00:00Z`) - Date.parse(`${added}T00:00:00Z`)) / 86400000);
  if (hint) {
    hint.textContent = `已按「${loc === "freezer" ? "冷冻" : loc === "pantry" ? "储物柜" : loc === "counter" ? "台面" : "冷藏"}约 ${days} 天」估算：${est.date}。包装上写了别的日期就改一下。`;
  }
}

// 放入日期改了，到期日跟着平移同样天数（保鲜期不变）：
// 「进库时间」变了，出库时间就该跟着变，不用再手改一次。
function bindDateShift(root, prefix) {
  const added = root.querySelector(`#${prefix}-added`);
  const date = root.querySelector(`#${prefix}-date`);
  if (!added || !date) return;
  date.dataset.prevAdded = added.value || "";
  added.addEventListener("change", () => {
    const prev = date.dataset.prevAdded;
    date.dataset.prevAdded = added.value || "";
    const hint = document.getElementById(`${prefix}-date-hint`);
    if (!date.value) {
      fillEstimatedDate(prefix); // 本来就没日期：按新的放入日期估一个
      return;
    }
    if (!prev || !added.value) return;
    const next = shiftExpiryDate(date.value, prev, added.value);
    if (!next) return;
    const delta = Math.round((Date.parse(`${added.value}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`)) / 86400000);
    date.value = next;
    if (hint) hint.textContent = `放入日期改了 ${delta > 0 ? "+" : ""}${delta} 天，到期日跟着挪到 ${next}（保质天数不变）。`;
  });
}

// 单位一律用下拉：常见单位 + 原本那个值（免得一保存就把不常见的旧单位改掉）
function unitOptions(current) {
  const list = [...new Set([...(COMMON_UNITS || []), current].filter(Boolean))];
  return list.map((u) => `<option value="${esc(u)}"${u === current ? " selected" : ""}>${esc(u)}</option>`).join("");
}

// 换单位时把数量一起换算：500 切成 kg 就变成 0.5，不用自己心算
function bindUnitScale(root, qtySelector, unitSelector, food) {
  const qty = root.querySelector(qtySelector);
  const unit = root.querySelector(unitSelector);
  if (!qty || !unit) return;
  const foodOf = typeof food === "function" ? food : () => food;
  let prev = unit.value;
  unit.addEventListener("change", () => {
    const v = parseFloat(qty.value);
    if (Number.isFinite(v) && v > 0) {
      const c = convert(foodOf(), v, prev, unit.value);
      if (c.certain) qty.value = Math.round(c.value * 1000) / 1000;
    }
    prev = unit.value;
  });
}

// 按食材的保鲜特性选个合理默认位置：只有冷冻的进冷冻室，只有常温的进储物柜。
function defaultLocation(food) {
  const s = (food && food.shelfLifeDays) || {};
  if (s.fridge != null) return "fridge";
  if (s.freezer != null) return "freezer";
  if (s.pantry != null) return "pantry";
  return "fridge";
}

function locationLabel(value) {
  const found = LOC_CHOICES.find(([k]) => k === value);
  return found ? found[1] : value;
}

// 勾选即完成：直接生成购买记录并入库，不再弹二次页面。
// 价格、位置、日期之后都可以点开「冰箱」里那条来改。
function buyItem(key, checkbox) {
  if (!checkbox.checked) {
    toast("要撤销请去「冰箱」删掉那条库存（撤销功能在 M2 做）");
    return;
  }
  const item = currentList().items.find((i) => (i.key || i.foodId) === key);
  if (!item || !item.packs) {
    toast("这一项暂时算不出购买量");
    return;
  }
  const foodId = item.foodId;
  const quantity = Math.round((item.shortfall + (item.leftover || 0)) * 1000) / 1000;
  const location = defaultLocation(foodsById().get(foodId));
  mutate((d) =>
    stockInPurchase(d, {
      foodId,
      quantity,
      unit: item.unit,
      amountPence: null,
      storeId: item.storeId,
      timing: item.timing,
      location,
      purchasedAt: new Date().toISOString(),
      nonce: Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    }).data,
    `买菜：${item.name}`
  );
  toast(`已入库：${item.name} ${quantity}${item.unit} · ${locationLabel(location)}`);
}

// 库存条目的二次页面：把「这次采购」和「库存」放在同一个弹窗里，价格就在这儿直接改。
function editInventory(id) {
  openPurchaseEditor({ batchId: id });
}

// 从「已买」那条进来：只改采购记录（库存可能已经被删掉了）。
function editPurchase(purchaseId) {
  openPurchaseEditor({ purchaseId });
}

function openPurchaseEditor({ purchaseId, batchId }) {
  const batch = batchId ? state.data.inventoryBatches.find((b) => b.id === batchId) : null;
  const pid = purchaseId || (batch && batch.sourcePurchaseId) || null;
  const p = pid ? state.data.purchases.find((x) => x.id === pid) : null;
  const foodId = p ? p.foodId : batch ? batch.foodId : null;
  const food = foodsById().get(foodId);
  const stores = state.data.settings.stores;

  const lastPrice = p && p.amountPence == null ? lastKnownPrice(state.data, p.foodId, p.id) : null;
  const priceValue = p && p.amountPence != null ? (p.amountPence / 100).toFixed(2) : lastPrice ? (lastPrice.amountPence / 100).toFixed(2) : "";
  const priceHint =
    p && p.amountPence == null && lastPrice
      ? `<p class="muted">上次（${esc(String(lastPrice.purchasedAt).slice(0, 10))}）买 ${lastPrice.quantity}${esc(lastPrice.unit)} 花了 ${formatPence(lastPrice.amountPence)}，已帮你填上，不对就改。</p>`
      : "";

  const purchaseBlock = p
    ? `
      <div class="list-heading">这次采购</div>
      <div class="grid2">
        <label>实际分量<input id="p-qty" type="number" min="0" step="1" value="${p.quantity}"></label>
        <label>单位<select id="p-unit">${unitOptions(p.unit)}</select></label>
      </div>
      <label>实际支付（£，可留空）<input id="p-price" type="number" min="0" step="0.01" value="${priceValue}"></label>
      ${priceHint}
      <div class="field">
        <span class="field-label">采购点</span>
        ${radioRow({
          id: "p-store",
          value: p.storeId || "",
          choices: [...stores.map((s) => [s.id, s.name]), ["stock", "库存·没花钱"]]
        })}
        <span class="muted">选「库存」就不用填价格：这东西本来就有，不算这周花的钱。</span>
      </div>
      <label class="checkline"><input id="p-remember" type="checkbox" checked> 以后都按这个包装买（更新默认规格）</label>
      <p class="muted"><button class="mini danger-mini" data-action="undo-purchase" data-purchase="${p.id}">撤销这次采购</button> <button class="mini" data-action="price-history" data-food="${p.foodId}">价格历史</button></p>`
    : "";

  const batchBlock = batch
    ? `
      <div class="list-heading">库存</div>
      <p class="muted">当前库存：${batch.quantityState === "exact" ? `${batch.quantity}${batch.unit || ""}` : `档位 ${batch.level || "unknown"}`}</p>
      ${
        p || batch.quantityState !== "exact"
          ? ""
          : `<div class="grid2">
               <label>数量<input id="b-qty" type="number" min="0" step="1" value="${batch.quantity == null ? "" : batch.quantity}"></label>
               <label>单位<select id="b-unit">${unitOptions(batch.unit || (food ? food.baseUnit : "g"))}</select></label>
             </div>`
      }
      <div class="field">
        <span class="field-label">位置</span>
        ${radioRow({ id: "e-loc", value: batch.location, choices: LOC_CHOICES })}
      </div>
      <label>放入日期<input id="e-added" type="date" value="${esc(batch.addedAt || "")}"></label>
      ${dateFields("e", {
        dtype: batch.dateType,
        date: batch.date,
        foodId: batch.foodId,
        locSel: "#e-loc",
        addedSel: "#e-added"
      })}
      <label class="checkline"><input id="e-opened" type="checkbox" ${batch.opened ? "checked" : ""}> 已开封</label>`
    : "";

  openModal({
    title: food ? food.name : "库存",
    body: purchaseBlock + batchBlock,
    okText: "保存",
    dangerText: batch ? "删除这条库存" : undefined,
    onMount: (m) => {
      bindUnitScale(m, "#p-qty", "#p-unit", food);
      bindUnitScale(m, "#b-qty", "#b-unit", food);
      // 这条库存还没填日期：按保鲜期估一个填上，直接保存就是估算日期
      if (batch && !batch.date) fillEstimatedDate("e");
      // 记住这个日期是怎么来的：估算的会跟着位置/放入日期重算，包装上的不动
      const eDate = m.querySelector("#e-date");
      if (eDate) eDate.dataset.source = batch ? batch.dateSource || (batch.date ? "package" : "") : "";
      bindDateShift(m, "e");
      // 换位置：估算的按新位置重算（冷冻能放更久），包装上的日期不变
      const eLoc = m.querySelector("#e-loc");
      if (eLoc && eLoc.parentElement) {
        eLoc.parentElement.addEventListener("click", () => {
          setTimeout(() => {
            if (eDate && eDate.dataset.source === "estimate") fillEstimatedDate("e");
          }, 0);
        });
      }
    },
    onOk: (m) => {
      const batchPatch = {};
      if (batch) {
        batchPatch.location = m.querySelector("#e-loc").value;
        batchPatch.addedAt = m.querySelector("#e-added").value || null;
        batchPatch.dateType = m.querySelector("#e-dtype").value;
        batchPatch.date = m.querySelector("#e-date").value || null;
        batchPatch.dateSource = batchPatch.date
          ? m.querySelector("#e-date").dataset.source || "package"
          : "none"; // 明确说「没日期」，以后别再自动估算
        batchPatch.opened = m.querySelector("#e-opened").checked;
        const qtyInput = m.querySelector("#b-qty");
        if (qtyInput) {
          const q = parseFloat(qtyInput.value);
          if (!Number.isFinite(q) || q < 0) {
            toast("数量填得不对");
            return false;
          }
          batchPatch.quantity = q;
          batchPatch.unit = m.querySelector("#b-unit").value.trim() || batch.unit;
        }
      }

      let purchaseInput = null;
      if (p) {
        const qty = parseFloat(m.querySelector("#p-qty").value);
        if (!Number.isFinite(qty) || qty <= 0) {
          toast("分量填得不对");
          return false;
        }
        const raw = m.querySelector("#p-price").value.trim();
        const amountPence = raw === "" ? null : Math.round(parseFloat(raw) * 100);
        if (amountPence != null && !Number.isFinite(amountPence)) {
          toast("金额填得不对");
          return false;
        }
        purchaseInput = {
          quantity: qty,
          unit: m.querySelector("#p-unit").value.trim() || p.unit,
          // 选「库存」= 这东西本来就有，不算这周花的钱：不记金额，也不更新默认规格
          amountPence: m.querySelector("#p-store").value === "stock" ? null : amountPence,
          storeId: m.querySelector("#p-store").value,
          remember: m.querySelector("#p-remember").checked
        };
      }

      mutate((d) => {
        let next = d;
        if (p && purchaseInput) {
          next = calibratePurchase(next, p.id, {
            quantity: purchaseInput.quantity,
            unit: purchaseInput.unit,
            amountPence: purchaseInput.amountPence,
            storeId: purchaseInput.storeId
          });
          if (purchaseInput.remember && purchaseInput.storeId !== "stock") {
            next = setFoodPack(next, p.foodId, {
              size: purchaseInput.quantity,
              unit: purchaseInput.unit,
              pricePence: purchaseInput.amountPence
            });
          }
        }
        if (batch) next = upsertBatch(next, { id: batch.id, ...batchPatch });
        return next;
      }, "校准库存");
      toast("已保存");
      return true;
    },
    onDanger: batch ? () => mutate((d) => removeBatch(d, batch.id)) : undefined
  });
}

// 补参考价：冰箱里没价的东西点一下「待补价」就能填，
// 填完以后预算、菜品成本、比价才有意义。
function setRefPrice(foodId, opts = {}) {
  const food = foodsById().get(foodId);
  if (!food) return;
  const pack = (food.packSizes || [])[0] || null;
  const store = (state.data.settings.stores || []).find((s) => s.id === food.storeHint);
  openModal({
    title: `补参考价：${food.name}`,
    body: `
      <p class="muted">照你平时买的那份填（比如 Aldi 一袋 500g 多少钱），填一次以后都按它估预算。</p>
      <div class="grid2">
        <label>分量<input id="rp-size" type="number" min="0" step="0.1" value="${pack ? pack.size : 1}"></label>
        <label>单位<select id="rp-unit">${unitOptions((pack && pack.unit) || food.baseUnit)}</select></label>
      </div>
      <label>这一份多少钱（£，可留空）<input id="rp-price" type="number" min="0" step="0.01" value="${
        pack && pack.pricePence != null ? (pack.pricePence / 100).toFixed(2) : ""
      }"></label>
      <p class="muted">${store ? `平时去：${esc(store.name)}` : "还没记过常去的店，买菜时在采购点里选一家就行。"}</p>`,
    okText: "保存",
    onMount: (m) => bindUnitScale(m, "#rp-size", "#rp-unit", food),
    onOk: (m) => {
      const size = parseFloat(m.querySelector("#rp-size").value);
      const unit = m.querySelector("#rp-unit").value;
      const raw = m.querySelector("#rp-price").value.trim();
      const pricePence = raw === "" ? null : Math.round(parseFloat(raw) * 100);
      if (!Number.isFinite(size) || size <= 0) {
        toast("分量填得不对");
        return false;
      }
      if (pricePence != null && !Number.isFinite(pricePence)) {
        toast("价格填得不对");
        return false;
      }
      mutate((d) => setFoodPack(d, foodId, { size, unit, pricePence }), `补参考价：${food.name}`);
      toast("已记参考价");
      // 从价格清单点进来的，填完回到清单继续看
      if (opts.from === "prices") showFoodPrices();
      if (opts.from === "dish-price") showDishPrice(opts.dish, opts.servings);
      return true;
    }
  });
}

// 价格二级页：
//   mode=week —— 本周要用的食材（从本周预算卡进），只列这周的，标出没价的
//   mode=all  —— 整库食材价格（从冰箱页进）
let priceBook = { mode: "all", query: "", filter: "all", limit: 40 };

// 一样食材的几批库存：点冰箱里那一行进来，逐批看/改/删
// 本周还没填实付金额的采购：就是「＋N 笔待补价」点进来的那一页
function showPendingPrices() {
  const range = currentRange(state.data);
  const rows = state.data.purchases
    // 标了「库存·没花钱」的不用再提醒（登记成库存就当免费）
    .filter((p) => p.amountPence == null && p.storeId !== "stock" && inRange(String(p.purchasedAt).slice(0, 10), range))
    .sort((a, b) => String(b.purchasedAt).localeCompare(String(a.purchasedAt)));
  const fById = foodsById();
  const stores = new Map((state.data.settings.stores || []).map((s) => [s.id, s.name]));
  const list = rows
    .map((p) => {
      const f = fById.get(p.foodId);
      const sameFood = rows.filter((x) => x.foodId === p.foodId);
      if (sameFood[0] !== p) return ""; // 同一食材多笔只出一行，避免看着像重复记录
      const b = state.data.inventoryBatches.find((x) => x.sourcePurchaseId === p.id);
      const bits = sameFood.map((x) => `${x.quantity}${x.unit}`);
      bits.push(sameFood.length > 1 ? `${sameFood.length} 笔，共` : "");
      bits.push(stores.get(p.storeId) || "未记店铺");
      bits.push(String(p.purchasedAt).slice(0, 10));
      if (b) bits.push(`还在冰箱：${b.quantity}${b.unit || ""}`);
      return `<li class="log-item">
        <div class="shop-main">
          <div class="log-msg">${esc(f ? f.name : p.foodId)} <span class="warn">金额待补${
            sameFood.length > 1 ? ` · ${sameFood.length} 笔` : ""
          }</span></div>
          <div class="shop-sub muted">${esc(bits.join(" · "))}</div>
        </div>
        <div class="stepper">
          <button class="mini primary" data-action="edit-purchase" data-purchase="${esc(p.id)}">填价</button>
          <button class="mini" data-action="mark-free" data-purchases="${esc(sameFood.map((x) => x.id).join(","))}">没花钱</button>
        </div>
      </li>`;
    })
    .join("");
  openModal({
    title: `本周还没填价的采购（${rows.length} 笔）`,
    body: `
      <p class="muted">这些是你在「买菜」里勾选入库、但没填实付金额的采购：东西已进冰箱、也从缺口里扣掉了，
      只是花了多少钱不知道，所以预算只能写「金额还不确定」（不会当成 £0 假装还剩多少）。</p>
      <p class="muted">家里本来就有的、别人给的、从国内带来的 —— 点「没花钱」就会标成「库存·没花钱」，之后不再提醒，也不算这周花钱；
      真花了钱就点「填价」照小票补上。同一食材有多笔会合并成一行。</p>
      <ul class="plain-list">${list || '<li class="muted">这周没有待补的</li>'}</ul>`,
    okText: "关闭"
  });
}

function showFoodBatches(foodId) {
  const food = foodsById().get(foodId);
  // 吃完的批次（数量扣到 0）已经不显示了，明细里也不列 —— 批次数跟冰箱里那颗按钮对得上
  const rows = state.data.inventoryBatches.filter((b) => b.foodId === foodId && hasStock(b));
  const today = todayISO(state.data.settings.budget.timezone);
  if (!rows.length) {
    toast("这条库存已经不在了");
    return;
  }
  const list = rows
    .map((b) => {
      const info = expiryInfo(b, today);
      const bits = [
        b.quantityState === "exact" ? `${b.quantity}${b.unit}` : `档位 ${b.level || "unknown"}`,
        locationLabel(b.location)
      ];
      if (b.addedAt) bits.push(`放入 ${b.addedAt}`);
      if (b.date) bits.push(`${b.dateType === "use_by" ? "use-by" : "best-before"} ${b.date}`);
      bits.push(expiryLabel(info));
      if (info.estimated) bits.push("估算");
      const p = b.sourcePurchaseId ? state.data.purchases.find((x) => x.id === b.sourcePurchaseId) : null;
      if (p) bits.push(p.amountPence == null ? `采购 ${p.storeId === "stock" ? "库存·没花钱" : "金额待补"}` : `采购 ${formatPence(p.amountPence)}`);
      return `<li class="log-item">
        <div class="shop-main">
          <div class="log-msg">${esc(b.quantityState === "exact" ? `${b.quantity}${b.unit}` : "档位库存")}${
            info.level === "expired" ? ' <span class="tag todo">已过期</span>' : info.level === "soon" ? ' <span class="tag todo">快到期</span>' : ""
          }</div>
          <div class="shop-sub muted">${esc(bits.join(" · "))}</div>
        </div>
        <div class="stepper">
          <button class="mini" data-action="inv-edit" data-id="${esc(b.id)}">改</button>
          <button class="mini danger-mini" data-action="inv-del" data-id="${esc(b.id)}">删</button>
        </div>
      </li>`;
    })
    .join("");
  openModal({
    title: `${food ? food.name : "库存"} · ${rows.length} 批`,
    body: `<p class="muted">同一样食材分了 ${rows.length} 批（采购时间和保质期不一样）。买菜、做饭、撤销都按批次记账，所以这里不合并。</p>
      <ul class="plain-list">${list}</ul>`,
    okText: "关闭"
  });
}

// 这道菜多少钱：按参考价折算每样食材摊到的钱，缺价的单独标出来，能直接补价
function showDishPrice(recipeId, servings) {
  const data = state.data;
  const recipe = recipesById().get(recipeId);
  if (!recipe) return;
  const serve = Number(servings) || recipe.baseServings;
  const { pence, unpriced, rows } = recipeCostBreakdown(recipe, data.foods, serve, {
    batches: data.inventoryBatches,
    purchases: data.purchases
  });
  const fById = foodsById();
  const stocked = new Set(
    data.inventoryBatches.filter((b) => b.quantityState === "exact" && hasStock(b)).map((b) => b.foodId)
  );

  const list = rows
    .map((r) => {
      const bits = [`${Math.round(r.amount * 100) / 100}${r.unit}`];
      if (r.packSize) bits.push(`按 ${r.packSize}${r.packUnit} ${formatPence(r.packPence)} 折算`);
      if (stocked.has(r.foodId)) bits.push("冰箱里有");
      return `<li class="log-item">
        <div class="shop-main">
          <div class="log-msg">${esc(r.name)} ${
            r.free
              ? '<span class="tag">库存·免费</span>'
              : r.pence != null
                ? `<span class="tag">${formatPence(r.pence)}</span>`
                : '<span class="tag todo">待补价</span>'
          }</div>
          <div class="shop-sub muted">${esc(bits.join(" · "))}${r.reason ? ` · ${esc(r.reason)}` : ""}</div>
        </div>
        ${
          r.pence == null
            ? `<button class="mini primary" data-action="set-ref-price" data-food="${r.foodId}" data-from="dish-price" data-dish="${recipe.id}" data-servings="${serve}">补价</button>`
            : ""
        }
      </li>`;
    })
    .join("");

  openModal({
    title: `${recipe.name} · 参考成本`,
    body: `
      <p class="muted">按 ${serve} 人份、你填的参考价折算，${rows.length} 样食材共 <b>${formatPence(pence)}</b>${
        unpriced ? `（<b class="warn">${unpriced} 项没有参考价</b>，没算进去，实际会更高）` : ""
      }。这不是这次买菜花的钱——同一包食材可能还做了别的菜。</p>
      <ul class="plain-list">${list}</ul>
      <p class="muted"><button class="mini" data-action="food-prices">全部食材价格</button></p>`,
    okText: "关闭"
  });
}

function showFoodPrices(patch = {}) {
  if (patch.reset) priceBook = { mode: patch.mode || "all", query: "", filter: "all", limit: 40 };
  else Object.assign(priceBook, patch);
  const data = state.data;
  const stores = new Map((data.settings.stores || []).map((s) => [s.id, s.name]));
  const { rows: shown, total, counts } = buildPriceBook(data, {
    query: priceBook.query,
    filter: priceBook.filter,
    limit: priceBook.limit
  });
  const chip = (key, label) =>
    `<button class="chip${priceBook.filter === key ? " active" : ""}" data-action="food-prices-filter" data-filter="${key}">${label}</button>`;

  const rows = shown
    .map(({ food: f, pack, priced, stock, unitPricePence: perUnit, noMoney }) => {
      const bits = [];
      if (pack) {
        bits.push(`包装 ${pack.size}${pack.unit}${pack.pricePence != null ? ` ${formatPence(pack.pricePence)}` : " 未记价"}`);
        if (perUnit != null) bits.push(`≈ ${unitPriceText(perUnit, pack.unit)}`);
      } else {
        bits.push("还没记过包装规格");
      }
      if (f.storeHint) bits.push(stores.get(f.storeHint) || f.storeHint);
      if (stock) bits.push(`冰箱里 ${Math.round(stock.qty * 10) / 10}${stock.unit}`);
      return `<li class="log-item">
        <div class="shop-main">
          <div class="log-msg">${esc(f.name)}${
            priced
              ? '<span class="tag">有价</span>'
              : noMoney
                ? '<span class="tag">库存·不记价</span>'
                : '<span class="tag todo">待补价</span>'
          }</div>
          <div class="shop-sub muted">${esc(bits.join(" · "))}</div>
        </div>
        <div class="stepper">
          <button class="mini${!priced && !noMoney ? " primary" : ""}" data-action="set-ref-price" data-food="${
            f.id
          }" data-from="prices">${priced ? "改价" : "补价"}</button>
          <button class="mini" data-action="price-history" data-food="${f.id}">历史</button>
        </div>
      </li>`;
    })
    .join("");

  openModal({
    title: "食材价格",
    body: `
      <p class="muted">共 ${counts.all} 样：有参考价 ${counts.priced} 样，待补价 ${counts.noprice} 样${
        counts.nomoney ? `（另有 ${counts.nomoney} 样记的是「库存·没花钱」，不用补价）` : ""
      }${
        counts.instock ? `，冰箱里有 ${counts.instock} 样` : ""
      }。</p>
      <input id="price-search" value="${esc(priceBook.query)}" autocomplete="off" placeholder="🔍 搜食材名">
      <div class="chips">${chip("all", `全部 ${counts.all}`)}${chip("noprice", `待补价 ${counts.noprice}`)}${chip(
        "priced",
        `有价 ${counts.priced}`
      )}${chip("instock", `冰箱里的 ${counts.instock}`)}</div>
      <div class="list-heading">${total} 样${total > shown.length ? `，先显示 ${shown.length} 样` : ""}</div>
      <ul class="plain-list">${rows || '<li class="muted">没找到</li>'}</ul>
      ${
        total > shown.length
          ? `<p class="muted"><button class="mini" data-action="food-prices-more">看更多</button></p>`
          : ""
      }`,
    okText: "关闭",
    onMount: (m) => {
      const box = m.querySelector("#price-search");
      box.addEventListener("input", () => {
        priceBook.query = box.value;
        priceBook.limit = 40;
        showFoodPrices();
      });
    }
  });
}

function cookMealAction(date) {
  const meal = state.data.meals.find((m) => m.id === `meal_${date}_dinner`);
  if (!meal || !meal.recipeId) return;
  const recipe = recipesById().get(meal.recipeId);
  if (!recipe) {
    toast("找不到这道食谱");
    return;
  }
  const servings = meal.actualServings != null ? meal.actualServings : state.data.settings.household.defaultServings;
  openModal({
    title: `做完「${recipe.name}」？`,
    body: `<p class="muted">按 ${servings} 人份从库存扣掉用掉的食材，并记一条做饭流水。库存不够的部分会标出来，不会记成负数。</p>`,
    okText: "做完",
    onOk: () => {
      mutate((d) => cookMeal(d, { mealId: meal.id, recipe, foods: d.foods, servings }).data, `做完：${recipe.name}`);
      toast("已扣减库存");
    }
  });
}

// 加食材到冰箱：食材库有五百多样，用一个下拉列表根本翻不动。
// 改成「搜索 + 点选」，选中后自动带出这个食材的基础单位和常见包装。
function addInventory() {
  const foods = [...state.data.foods].sort((a, b) => (a.name > b.name ? 1 : -1));
  const today = todayISO(state.data.settings.budget.timezone);
  let picked = null;

  const stockLabel = (f) => {
    // 档位库存没有精确数量，不参与「已有 x」；吃完的批次也不算
    const bs = state.data.inventoryBatches.filter((b) => b.foodId === f.id && b.quantityState === "exact" && hasStock(b));
    if (!bs.length) return "";
    const qty = bs.reduce((s, b) => s + b.quantity, 0);
    return `已有 ${Math.round(qty * 10) / 10}${bs[0].unit}`;
  };

  openModal({
    title: "加食材到冰箱",
    body: `
      <label>找食材<input id="i-search" autocomplete="off" placeholder="输入名字，比如：洋葱、鸡蛋、番茄"></label>
      <div id="i-results" class="pick-list"></div>
      <p class="muted" id="i-picked">还没选食材</p>
      <div class="grid2">
        <label>数量<input id="i-qty" type="number" min="0" step="1" value="1"></label>
        <label>单位<select id="i-unit">${unitOptions("g")}</select></label>
      </div>
      <div class="field">
        <span class="field-label">位置</span>
        ${radioRow({ id: "i-loc", value: "fridge", choices: LOC_CHOICES })}
      </div>
      <label>放入日期<input id="i-added" type="date" value="${today}"></label>
      ${dateFields("i", { dtype: "unknown", date: "", locSel: "#i-loc", addedSel: "#i-added" })}`,
    okText: "加进去",
    onMount: (m) => {
      const box = m.querySelector("#i-results");
      const search = m.querySelector("#i-search");
      const pickedEl = m.querySelector("#i-picked");
      const paint = () => {
        const q = search.value.trim();
        const list = (
          q
            ? foods.filter(
                (f) => f.name.includes(q) || (f.aliases || []).some((a) => String(a).toLowerCase().includes(q.toLowerCase()))
              )
            : foods
        ).slice(0, 12);
        box.innerHTML =
          list
            .map(
              (f) =>
                `<button type="button" class="pick${picked && picked.id === f.id ? " active" : ""}" data-food="${f.id}">${esc(
                  f.name
                )}<span class="muted">${esc(stockLabel(f))}</span></button>`
            )
            .join("") || '<p class="muted">没找到，换个词试试</p>';
      };
      box.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-food]");
        if (!btn) return;
        picked = foods.find((f) => f.id === btn.dataset.food) || null;
        if (!picked) return;
        const pack = picked.packSizes && picked.packSizes[0];
        m.querySelector("#i-unit").value = picked.baseUnit;
        m.querySelector("#i-qty").value = pack ? pack.size : 1;
        m.querySelector("#i-loc").value = defaultLocation(picked);
        pickedEl.innerHTML = `已选：<b>${esc(picked.name)}</b> · 单位 ${esc(picked.baseUnit)}${
          pack ? ` · 常见包装 ${pack.size}${esc(pack.unit)}` : ""
        }`;
        m.querySelector("#i-date").dataset.food = picked.id; // 估算要用到选了哪样食材
        fillEstimatedDate("i"); // 选完食材就把到期日按保鲜期填好，不用手打
        paint();
      });
      search.addEventListener("input", paint);
      bindDateShift(m, "i");
      // 换位置 / 换放入日期，估算跟着变
      const iLoc = m.querySelector("#i-loc");
      if (iLoc && iLoc.parentElement) {
        iLoc.parentElement.addEventListener("click", () => setTimeout(() => fillEstimatedDate("i"), 0));
      }
      bindUnitScale(m, "#i-qty", "#i-unit", () => picked);
      paint();
    },
    onOk: (m) => {
      if (!picked) {
        toast("先在上面选一样食材");
        return false;
      }
      const quantity = parseFloat(m.querySelector("#i-qty").value) || 0;
      if (quantity <= 0) {
        toast("数量要大于 0");
        return false;
      }
      const batch = newBatch({
        foodId: picked.id,
        quantity,
        unit: m.querySelector("#i-unit").value.trim() || picked.baseUnit,
        location: m.querySelector("#i-loc").value,
        dateType: m.querySelector("#i-dtype").value,
        date: m.querySelector("#i-date").value || null,
        addedAt: m.querySelector("#i-added").value || null,
        dateSource: m.querySelector("#i-date").value
          ? m.querySelector("#i-date").dataset.source || "package"
          : "none"
      });
      mutate(
        (d) => ({ ...d, inventoryBatches: [...d.inventoryBatches, batch] }),
        `冰箱加食材：${picked.name}`
      );
      toast("已加进冰箱");
      return true;
    }
  });
}

function saveSettings() {
  const servings = parseInt(document.getElementById("set-servings").value, 10);
  const budgetPounds = parseFloat(document.getElementById("set-budget").value) || 0;
  mutate((d) => {
    const stores = (d.settings.stores || []).map((s) => {
      const el = document.querySelector(`[data-store-role="${s.id}"]`);
      return el ? { ...s, role: el.value } : s;
    });
    return updateSettings(d, {
      household: { defaultServings: servings },
      budget: { weeklyPence: Math.round(budgetPounds * 100) },
      stores
    });
  }, "改设置");
  toast("设置已保存");
}

function saveSyncConfig() {
  saveConfig({
    owner: document.getElementById("cfg-owner").value.trim(),
    repo: document.getElementById("cfg-repo").value.trim(),
    branch: document.getElementById("cfg-branch").value.trim() || "main",
    path: document.getElementById("cfg-path").value.trim() || "data.json",
    token: document.getElementById("cfg-token").value.trim()
  });
  toast("配置已存在本机");
}

// 撤销一次采购：删掉采购记录和它入库的库存，并记一条反向流水。已经做过饭的不让撤销。
function undoPurchaseAction(purchaseId) {
  const p = state.data.purchases.find((x) => x.id === purchaseId);
  if (!p) return;
  const food = foodsById().get(p.foodId);
  const name = food ? food.name : "";
  const check = undoPurchase(structuredClone(state.data), purchaseId);
  if (!check.ok) {
    toast(check.reason);
    return;
  }
  openModal({
    title: "撤销这次采购？",
    body: `<p class="muted">会删掉${name ? `「${esc(name)}」的` : ""}这条购买记录和它入库的库存，并记一条反向流水。历史都留着，之后还能从操作日志回到这一版。</p>`,
    okText: "撤销",
    onOk: () => {
      mutate((d) => undoPurchase(d, purchaseId).data, `撤销采购：${name}`);
      return true;
    }
  });
}

// 撤销「做完」：把扣掉的食材还回库存，餐次回到「已安排」。
function undoCookAction(date) {
  const meal = state.data.meals.find((m) => m.id === `meal_${date}_dinner`);
  if (!meal) return;
  const check = undoCook(structuredClone(state.data), meal.id);
  if (!check.ok) {
    toast(check.reason);
    return;
  }
  openModal({
    title: "撤销「做完」？",
    body: `<p class="muted">会把这次扣掉的食材还回库存，餐次回到「已安排」，做饭记录标记为已撤销。</p>${
      check.missing && check.missing.length
        ? `<p class="muted">注意：${check.missing.length} 样食材的库存批次已经被删掉，这部分补不回来（其余会照常还回去）。</p>`
        : ""
    }`,
    okText: "撤销",
    onOk: () => {
      const res = undoCook(structuredClone(state.data), meal.id);
      mutate(() => res.data, `撤销做完：${date.slice(5)}`);
      if (res.missing && res.missing.length) toast(`已撤销，但有 ${res.missing.length} 样库存批次不见了`);
      return true;
    }
  });
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 没权限或不是安全上下文，退回到手动复制 */
  }
  return false;
}

// 生成存档文本：压缩 + 混淆成一串，复制走就能存
function showSaveText() {
  const text = exportSaveText();
  if (!text) {
    toast("还没有数据可以导出");
    return;
  }
  openModal({
    title: `存档文本 · ${text.length} 字符`,
    body: `<p class="muted">点「复制」存到备忘录、聊天窗口或云笔记都行；读档时整段粘贴回来。</p>
      <textarea id="save-text" readonly rows="8">${esc(text)}</textarea>`,
    okText: "复制",
    onOk: (m) => {
      copyToClipboard(m.querySelector("#save-text").value).then((ok) =>
        toast(ok ? "已复制到剪贴板" : "复制失败，请长按选中手动复制")
      );
    }
  });
}

// 粘贴读档：先解出并校验，通过才替换数据
function showLoadText() {
  openModal({
    title: "粘贴读档",
    body: `<p class="muted">把之前复制的存档文本整段粘贴进来。会先校验，通过后才替换数据。</p>
      <textarea id="load-text" rows="8" placeholder="DIN1:..."></textarea>`,
    okText: "读取",
    onOk: async (m) => {
      const text = m.querySelector("#load-text").value;
      if (!text.trim()) {
        toast("先粘贴存档文本");
        return false;
      }
      const res = await importSaveText(text);
      toast(res.ok ? "已读档，正在写入远端" : res.reason);
      return res.ok;
    }
  });
}

// 价格历史：按店汇总 + 每次明细，单位价换算成 £/kg 这类，方便跨规格比较
function showPriceHistory(foodId) {
  const food = foodsById().get(foodId);
  const h = foodPriceHistory(state.data, foodId);
  const pack = food && food.packSizes && food.packSizes.length ? food.packSizes[0] : null;
  const refLine =
    pack && pack.pricePence != null ? `当前参考价：${pack.size}${esc(pack.unit)} ${formatPence(pack.pricePence)}` : "当前参考价：未设";

  const storeRows = h.stores
    .map(
      (s) => `<li class="log-item"><div class="shop-main">
        <div class="log-msg">${esc(s.store)}</div>
        <div class="shop-sub muted">最近 ${s.latest.quantity}${esc(s.unit)} ${formatPence(s.latest.amountPence)} · 最低 ${unitPriceText(
          s.cheapestUnitPence,
          s.unit
        )} · 均价 ${unitPriceText(s.avgUnitPence, s.unit)} · 共 ${s.count} 次</div>
      </div></li>`
    )
    .join("");

  const rows = h.entries
    .map(
      (e) => `<li class="log-item"><div class="shop-main">
        <div class="log-msg">${esc(e.store)} · ${e.quantity}${esc(e.unit)} ${
        e.amountPence == null ? '<span class="warn">待补全</span>' : formatPence(e.amountPence)
      }</div>
        <div class="shop-sub muted">${esc(e.at)}${e.unitPricePence != null ? ` · ${unitPriceText(e.unitPricePence, e.unit)}` : ""}</div>
      </div></li>`
    )
    .join("");

  openModal({
    title: `${food ? food.name : "食材"} · 价格历史`,
    body: `
      <p class="muted">${refLine}</p>
      ${
        h.latest
          ? `<p class="muted"><button class="mini" data-action="adopt-price" data-food="${foodId}">用最近一次（${h.latest.quantity}${esc(
              h.latest.unit
            )} ${formatPence(h.latest.amountPence)}）当参考价</button></p>`
          : ""
      }
      ${h.stores.length ? `<div class="list-heading">按店汇总</div><ul class="plain-list">${storeRows}</ul>` : ""}
      <div class="list-heading">每次购买</div>
      <ul class="plain-list">${rows || '<li class="muted">还没有记录</li>'}</ul>`,
    okText: "关闭"
  });
}

// 调整食谱食材：勾选保留、改分量、加新食材，一次保存
function editRecipeIngredients(recipeId) {
  const r = recipesById().get(recipeId);
  if (!r) return;
  const fById = foodsById();
  const rows = r.ingredients
    .map(
      (ing, i) => `<li class="ing-row">
        <input type="checkbox" data-keep="${i}" checked>
        <span class="ing-name">${esc(fById.get(ing.foodId) ? fById.get(ing.foodId).name : ing.foodId)}</span>
        <input type="number" min="0" step="0.5" data-amt="${i}" value="${ing.amount}">
        <select class="unit-input" data-unit="${i}">${unitOptions(ing.unit)}</select>
      </li>`
    )
    .join("");
  const foodOptions = [...state.data.foods]
    .sort((a, b) => (a.name > b.name ? 1 : -1))
    .map((f) => `<option value="${f.id}">${esc(f.name)}</option>`)
    .join("");

  openModal({
    title: `调整食材：${r.name}`,
    body: `
      <p class="muted">勾选 = 保留；取消勾选的保存后会被移除，分量填 0 也会去掉。</p>
      ${servingsField("r-servings", r.baseServings, { min: 1, max: 12, label: "基准份数" })}
      <div class="list-heading">食材（${r.ingredients.length}）</div>
      <ul class="plain-list">${rows || '<li class="muted">还没有食材</li>'}</ul>
      <div class="list-heading">添加食材</div>
      <ul class="plain-list"><li class="ing-row">
        <span class="ing-name">＋</span>
        <select id="add-food"><option value="">（不添加）</option>${foodOptions}</select>
        <input type="number" min="0" step="0.5" id="add-amt" value="100">
        <select class="unit-input" id="add-unit">${unitOptions("g")}</select>
      </li></ul>
      <label>标签<input id="r-tags" type="text" autocomplete="off" value="${esc((r.tags || []).join("、"))}" placeholder="家常菜、正餐"></label>
      <p class="muted">「家常菜」和「正餐」两个标签都在，才会出现在一周推荐和单日推荐里。用「、」隔开。</p>`,
    okText: "保存",
    onMount: (m) => {
      bindServings(m, "r-servings");
      // 每行的数量跟着单位换算；添加食材那行等选好食材后再按它的换算算
      r.ingredients.forEach((ing, i) => {
        bindUnitScale(m, `[data-amt="${i}"]`, `[data-unit="${i}"]`, fById.get(ing.foodId));
      });
      const addFood = m.querySelector("#add-food");
      bindUnitScale(m, "#add-amt", "#add-unit", () => fById.get(addFood.value));
    },
    onOk: (m) => {
      const ingredients = [];
      r.ingredients.forEach((ing, i) => {
        if (!m.querySelector(`[data-keep="${i}"]`).checked) return;
        const amt = parseFloat(m.querySelector(`[data-amt="${i}"]`).value);
        const unit = m.querySelector(`[data-unit="${i}"]`).value.trim() || ing.unit;
        if (!Number.isFinite(amt) || amt <= 0) return;
        ingredients.push({ foodId: ing.foodId, amount: amt, unit });
      });
      const addFood = m.querySelector("#add-food").value;
      if (addFood) {
        const amt = parseFloat(m.querySelector("#add-amt").value);
        const unit = m.querySelector("#add-unit").value.trim() || "g";
        if (Number.isFinite(amt) && amt > 0) ingredients.push({ foodId: addFood, amount: amt, unit });
      }
      if (!ingredients.length) {
        toast("至少留一样食材");
        return false;
      }
      const baseServings = readServings(m, "r-servings", r.baseServings);
      const tags = m
        .querySelector("#r-tags")
        .value.split(/[、,，/|]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      mutate((d) => updateRecipe(d, r.id, { ingredients, baseServings, tags }), `调整食材：${r.name}`);
      toast("已保存");
      return true;
    }
  });
}

let weekPlanSeed = 1;

// 全部推荐：冰箱页只放 5 条，其余进这个二级页
let suggestState = { limit: 30 };

function showAllSuggestions(patch = {}) {
  if (patch.reset) suggestState = { limit: 30 };
  else Object.assign(suggestState, patch);

  const data = state.data;
  const today = todayISO(data.settings.budget.timezone);
  const { items, total } = suggestRecipes(data, { limit: suggestState.limit, today });
  const range = currentRange(data);
  const planned = new Set(
    data.meals
      .filter((m) => m.recipeId && ["planned", "cooking"].includes(m.state) && inRange(m.date, range))
      .map((m) => m.recipeId)
  );
  const sorted = [...items].sort((a, b) => (planned.has(b.recipeId) ? 1 : 0) - (planned.has(a.recipeId) ? 1 : 0));

  const rows = sorted
    .map(
      (s) => `<li class="log-item">
        <div class="shop-main">
          <div class="log-msg">${planned.has(s.recipeId) ? '<span class="tag star">⭐ 本周定了</span> ' : ""}${esc(
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
          <button class="mini primary" data-action="add-to-week" data-id="${s.recipeId}">加入本周</button>
          <button class="mini" data-action="open-recipe" data-id="${s.recipeId}">做法</button>
        </div>
      </li>`
    )
    .join("");

  openModal({
    title: "用现有食材能做的菜",
    body: `
      <p class="muted">共 ${total} 道能做或差一点就能做，${items.length === total ? "全在这儿了" : `先显示前 ${items.length} 道`}。
      点菜名改食材，右侧加进本周。</p>
      <ul class="plain-list">${rows || '<li class="muted">现有食材还凑不出一道菜</li>'}</ul>
      ${
        total > items.length
          ? `<p class="muted"><button class="mini" data-action="all-suggestions-more">看更多（还有 ${total - items.length} 道）</button></p>`
          : ""
      }`,
    okText: "关闭"
  });
}

// 有菜的日子：把「不做了」的几种收进这个二级页，免得一天摆一排按钮
function showDayActions(date) {
  const meal = state.data.meals.find((m) => m.id === `meal_${date}_dinner`);
  const recipe = meal && meal.recipeId ? recipesById().get(meal.recipeId) : null;
  openModal({
    title: `${WEEKDAY_LABEL[weekdayIndex(date)]} ${date.slice(5)} 改状态`,
    body: `
      ${
        recipe
          ? `<p class="muted">这天是：<span class="link" data-action="edit-recipe-ingredients" data-id="${recipe.id}">${esc(
              recipe.name
            )}</span></p>`
          : '<p class="muted">这天还没排菜。</p>'
      }
      <div class="actions">
        <button class="mini primary" data-action="day-set" data-date="${date}" data-state="eating_out">外食</button>
        <button class="mini" data-action="day-set" data-date="${date}" data-state="skipped">跳过</button>
        <button class="mini" data-action="day-set" data-date="${date}" data-state="leftovers">吃剩菜</button>
      </div>
      <p class="muted">改完这天就不再算进买菜清单，也不占预算。</p>
      <p class="muted"><button class="mini danger-mini" data-action="day-clear" data-date="${date}">清空这天</button></p>`,
    okText: "关闭"
  });
}

// 单日推荐的状态：
// rejected = 主推那边「换一道」换掉的菜，别再推上来
// seenBackups = 备选里已经给你看过的菜，「换一批」要把它们排掉，而不是重新洗同一批
function freshDaySug(date) {
  const rand = () => Math.floor(Math.random() * 100000) + 1;
  return { date, seed: rand(), backupSeed: rand(), rejected: [], pickId: null, seenBackups: [], backupIds: [] };
}

let daySugState = freshDaySug(null);

// 单日推荐：只给这一天挑一道菜。偏好和一周推荐一致（先用冰箱里的、顺手消耗快过期的、成本可信的），
// 采用前先把「排进去之后本周采购多少钱」摆出来，方便盯餐标。
function showDaySuggestion(date, { forceId } = {}) {
  const data = state.data;
  const today = todayISO(data.settings.budget.timezone);
  const range = rangeOfDate(date); // 这一天属于哪一周，就按哪一周算买菜钱
  const servings = data.settings.household.defaultServings;
  if (daySugState.date !== date) {
    daySugState = freshDaySug(date);
  }

  const res = suggestDay(data, {
    date,
    today,
    servings,
    seed: daySugState.seed,
    exclude: daySugState.rejected,
    limit: 200
  });
  if (!res.items.length) {
    toast(daySugState.rejected.length ? "能想到的都换过一遍了" : "菜谱库里还没有可用的菜");
    return;
  }
  const pick = (forceId && res.items.find((i) => i.recipeId === forceId)) || res.items[0];
  daySugState.pickId = pick.recipeId;

  // 备选：先排掉已经看过的那几批，所以「换一批」每次都是没见过的菜，不动上面推荐的那道
  const backupPick = (seed) =>
    suggestDay(data, {
      date,
      today,
      servings,
      seed,
      exclude: [...daySugState.rejected, pick.recipeId, ...daySugState.seenBackups],
      limit: 4
    }).items;
  let backupItems = backupPick(daySugState.backupSeed);
  if (!backupItems.length && daySugState.seenBackups.length) {
    // 候选都被看完了：重新洗一批，别让按钮点了没反应
    daySugState.seenBackups = [];
    daySugState.backupSeed = Math.floor(Math.random() * 100000) + 1;
    backupItems = backupPick(daySugState.backupSeed);
  }
  daySugState.backupIds = backupItems.map((i) => i.recipeId);

  const meals = data.meals;
  const meal = meals.find((m) => m.id === `meal_${date}_dinner`);
  const est = estimateWithPick(data, { range, date, servings, recipeId: pick.recipeId });
  const missing = pick.missing.slice(0, 6).map((m) => `${esc(m.name)} ${m.short}${esc(m.unit)}`);
  const seasoning = pick.missingSeasoning.slice(0, 4).map((m) => esc(m.name));
  const backups = backupItems
    .map(
      (i) => `<li class="fridge-item" data-action="preview-day-pick" data-date="${date}" data-recipe="${i.recipeId}">
        <div class="shop-main">
          <div class="log-msg">${esc(i.name)}${i.alreadyPlanned ? ' <span class="tag">本周已有</span>' : ""}</div>
          <div class="shop-sub muted">${esc(i.category || "")}${i.covered ? ` · 用掉现成 ${i.covered} 样` : ""}${
            i.missing.length ? ` · 还缺 ${i.missing.length} 样` : " · 食材齐"
          } · 参考成本 ${formatPence(i.cost)}</div>
        </div>
      </li>`
    )
    .join("");

  openModal({
    title: `${WEEKDAY_LABEL[weekdayIndex(date)]} ${date.slice(5)} 吃什么`,
    body: `
      <p class="muted">按 ${servings} 人份推荐这一道：</p>
      <section class="card">
        <div class="shop-name">${esc(pick.name)}</div>
        <div class="shop-sub muted">${esc(pick.category || "")} · 参考成本 ${formatPence(pick.cost)}${
          pick.reliableCost ? "" : "（参考价不全，只作参考）"
        } · ${pick.covered ? `用掉现成食材 ${pick.covered} 样` : "冰箱里没有现成的"}${
          pick.warnUsed.length ? ` · 顺手消耗快过期：${esc(pick.warnUsed.join("、"))}` : ""
        }</div>
        <div class="shop-sub muted">${
          missing.length ? `还缺：${missing.join("、")}` : "主料都齐了"
        }${seasoning.length ? `；调料可能缺：${seasoning.join("、")}` : ""}</div>
      </section>
      <p class="muted">排进这天后，本周采购预计 <b class="${est.over ? "over-text" : ""}">${formatPence(
        est.estimatePence
      )}</b> / 预算 ${formatPence(est.budgetPence)}${est.over ? "（超预算）" : ""}${
        est.unpricedCount ? ` · 另有 ${est.unpricedCount} 项没参考价` : ""
      }</p>
      ${servingsField("d-servings", (meal && meal.actualServings) || servings, {
        max: Math.max(8, (meal && meal.actualServings) || servings)
      })}
      <p class="muted">想留隔天午饭就把份数调大（2 人吃、做 4 份）。</p>
      <p class="muted"><button class="mini" data-action="reroll-day" data-date="${date}">换一道</button></p>
      ${
        backups
          ? `<div class="row between">
              <div class="list-heading">备选（点一下看这道）</div>
              <button class="mini" data-action="reroll-day-backups" data-date="${date}">换一批</button>
            </div><ul class="plain-list">${backups}</ul>`
          : ""
      }`,
    okText: "用这道",
    onMount: (m) => bindServings(m, "d-servings"),
    onOk: (m) => {
      const sv = readServings(m, "d-servings", servings);
      mutate(
        (d) => upsertMeal(d, date, { state: "planned", recipeId: pick.recipeId, actualServings: sv, servingsConfirmed: true }),
        `单日推荐：${pick.name}`
      );
      toast(`已安排：${pick.name}`);
    }
  });
}

// 一周推荐菜单：先给个预览，满意了再一键排进本周
function showWeekPlan(seed) {
  weekPlanSeed = seed;
  const data = state.data;
  const today = todayISO(data.settings.budget.timezone);
  const range = viewedRange(); // 正在看哪一周，就把那一周排满
  const servings = data.settings.household.defaultServings;
  const plan = suggestWeek(data, { range, today, servings, budgetPence: data.settings.budget.weeklyPence, seed });

  const rows = plan.picks
    .map(
      (p) => `<li class="log-item"><div class="shop-main">
        <div class="log-msg">${esc(WEEKDAY_LABEL[weekdayIndex(p.date)])} ${esc(p.date.slice(5))} · <span class="link" data-action="edit-recipe-ingredients" data-id="${p.recipeId}">${esc(p.name)}</span></div>
        <div class="shop-sub muted">${esc(p.category || "")} · 参考成本 ${formatPence(p.cost)}${
        p.covered ? ` · 用掉现成食材 ${p.covered} 样` : ""
      }${p.warnHit ? " · 含快到期" : ""}</div>
      </div></li>`
    )
    .join("");

  openModal({
    title: "一周推荐菜单",
    body: `
      <p class="muted">按 ${servings} 人份、周预算 ${formatPence(plan.budgetPence)} 排的：尽量用冰箱里现有的、优先消耗快过期的，并尽量不重样。</p>
      <ul class="plain-list">${rows || '<li class="muted">菜谱库还没有可用的菜</li>'}</ul>
      <p class="muted">这周采购预计 <b>${formatPence(plan.estimatePence)}</b>（已扣掉库存）${
        plan.note ? ` · <span class="warn">${esc(plan.note)}</span>` : ""
      }</p>
      <p class="muted"><button class="mini" data-action="reroll-week">换一套</button></p>`,
    okText: "用这套",
    onOk: () => {
      if (!plan.picks.length) {
        toast("没有可排的菜");
        return false;
      }
      mutate((d) => applyWeekPlan(d, plan.picks, servings), `套用一周推荐菜单（${plan.picks.length} 顿）`);
      toast(`已排入 ${plan.picks.length} 顿`);
      return true;
    }
  });
}

// 一键优化排期：先给一份「哪天换到哪天、为什么」的预览，满意了再落地。
// 重排规则在 src/rules/optimize.js 里（纯函数），这里只负责把结果讲清楚。
let optimizePatch = { fillEmpty: true, purge: false };

function showOptimizeWeek(patch = {}) {
  Object.assign(optimizePatch, patch);
  const data = state.data;
  const today = todayISO(data.settings.budget.timezone);
  const range = viewedRange(); // 正在看哪一周就优化哪一周（提前排下周也走这里）
  const servings = data.settings.household.defaultServings;
  const plan = optimizeWeek(data, {
    range,
    today,
    servings,
    budgetPence: data.settings.budget.weeklyPence,
    fillEmpty: optimizePatch.fillEmpty
  });

  const KIND_LABEL = { keep: "照旧", move: "挪", swap: "对调", replace: "换菜", new: "新排", empty: "空着" };
  const rows = plan.days
    .map((row) => {
      const head = `${WEEKDAY_LABEL[weekdayIndex(row.date)]} ${row.date.slice(5)}`;
      const badge = `<span class="${row.kind === "keep" ? "muted" : "warn"}">${KIND_LABEL[row.kind] || row.kind}</span>`;
      const name = row.recipeId ? esc(row.name) : '<span class="muted">（空着）</span>';
      const from = row.from && row.from.name ? ` <span class="muted">（原来：${esc(row.from.name)}）</span>` : "";
      const why = row.reasons.length ? `<div class="shop-sub muted">${row.reasons.map((x) => esc(x)).join("；")}</div>` : "";
      return `<li class="log-item"><div class="shop-main">
        <div class="log-msg">${head} · ${badge} ${name}${from}</div>${why}
      </div></li>`;
    })
    .join("");

  const c = plan.counts;
  const summary = `对调 ${c.swap || 0} · 挪动 ${c.move || 0} · 换菜 ${c.replace || 0} · 新排 ${c.new || 0} · 照旧 ${
    c.keep || 0
  }${c.empty ? ` · 空着 ${c.empty}` : ""}`;

  const spoiled = plan.spoiled.length
    ? `<p class="warn">冰箱里有 ${plan.spoiled.length} 批已经坏了：${plan.spoiled
        .map((s) => `${esc(s.name)}（use-by ${esc(s.date)}${s.quantity ? `，${esc(String(s.quantity))}${esc(s.unit || "")}` : ""}）`)
        .join("、")}。这次排期不再用它们。</p>
      <label class="checkline"><input type="checkbox" id="opt-purge" ${optimizePatch.purge ? "checked" : ""}> 顺手扔掉这 ${
        plan.spoiled.length
      } 批（过期的不能再吃了）</label>`
    : "";

  const lockedLine = plan.locked.length
    ? `<p class="muted">你自己定的 ${plan.locked.length} 天不动：${plan.locked
        .map((l) => `${l.date.slice(5)} ${lockedLabel(l.state)}`)
        .join("、")}。</p>`
    : "";
  const pastLine = plan.past.length
    ? `<p class="muted">今天以前：${plan.past
        .map((p) =>
          p.action === "moved"
            ? `${p.date.slice(5)} 没做成的「${esc(p.name)}」顺到 ${p.to.slice(5)}`
            : p.action === "spoiled"
              ? `${p.date.slice(5)} 的「${esc(p.name)}」主料坏了，这次跳过`
              : `${p.date.slice(5)} 的「${esc(p.name)}」没做成，今天及以后也没空位放它了`
        )
        .join("；")}。</p>`
    : "";
  const suspectLine = plan.suspect.length
    ? `<p class="warn">这几批按估算日期已经过期（估算，不是包装上印的日期，所以我不能替你判断能不能吃）：${plan.suspect
        .map((s) => `${esc(s.name)}（${esc(s.date)}${s.quantity ? `，${esc(String(s.quantity))}${esc(s.unit || "")}` : ""}）`)
        .join("、")}。打开看看，坏了就扔掉。</p>`
    : "";
  const noOpenDays = !plan.days.length;
  const intro = noOpenDays
    ? `<p class="warn">今天（${today.slice(5)}）及以后没有还能重排的天，这次没有排期可以改。下面是这周还悬着的事 —— 想处理的话，回「本周」点某天的按钮就行。</p>`
    : `<p class="muted">按 ${servings} 人份重排 ${range.start.slice(5)} 到 ${range.end.slice(5)}（从今天 ${today.slice(5)} 起）：快过期的菜往前提，来不及的换一道，能对调就只对调。</p>`;
  const rescueLine = plan.rescueNotes.length
    ? `<p class="muted">顺手用掉：${plan.rescueNotes.map((x) => esc(x)).join("、")}。</p>`
    : "";

  openModal({
    title: noOpenDays ? "一键优化排期 · 没得排了" : "一键优化排期",
    body: `
      ${intro}
      ${spoiled}
      ${suspectLine}
      ${noOpenDays ? "" : `<p class="muted">${summary}</p><ul class="plain-list">${rows}</ul>`}
      ${lockedLine}
      ${pastLine}
      ${rescueLine}
      ${
        noOpenDays
          ? ""
          : `<p class="muted">改完这周采购预计 <b class="${plan.overBudget ? "over-text" : ""}">${formatPence(
              plan.estimatePence
            )}</b> / 预算 ${formatPence(plan.budgetPence)}${plan.note ? ` · <span class="warn">${esc(plan.note)}</span>` : ""}</p>
            <label class="checkline"><input type="checkbox" id="opt-fill" ${optimizePatch.fillEmpty ? "checked" : ""}> 空白的天也一起排上</label>`
      }
      ${noOpenDays ? "" : `<p class="muted">落下去之后还能在「本周」里拖动对调，或点某天的「换」改单天。</p>`}`,
    okText: noOpenDays ? "知道了" : "用这套",
    onMount: (m) => {
      const fill = m.querySelector("#opt-fill");
      if (fill) fill.addEventListener("change", () => showOptimizeWeek({ fillEmpty: fill.checked }));
      const purge = m.querySelector("#opt-purge");
      if (purge)
        purge.addEventListener("change", () => {
          optimizePatch.purge = purge.checked;
        });
    },
    onOk: () => {
      const purge = optimizePatch.purge ? plan.purgeBatchIds.slice() : [];
      if (!plan.changedCount && !purge.length) {
        toast(noOpenDays ? "今天及以后没有能重排的天" : "这周已经排得挺顺了，没找到要改的地方");
        return false;
      }
      if (noOpenDays && !purge.length) return false;
      mutate(
        (d) => applyOptimizedWeek(d, plan, { purgeBatchIds: purge }),
        `一键优化排期（${plan.changedCount} 处改动${purge.length ? `，扔掉 ${purge.length} 批过期库存` : ""}）`
      );
      toast(
        plan.changedCount
          ? `已重排 ${plan.changedCount} 处${purge.length ? `，扔掉 ${purge.length} 批` : ""}`
          : `已扔掉 ${purge.length} 批过期库存`
      );
    }
  });
}

function lockedLabel(state) {
  return { done: "已做完", eating_out: "外食", skipped: "跳过", leftovers: "吃剩菜" }[state] || state;
}

// 「吃的日历」：月历 + 那天吃了什么 + 那一周。
// 只读（改不了任何东西），事实源是做饭记录，所以「排了没做」不会被算成吃过。
let calState = { month: null, day: null };

function showCalendar(patch = {}) {
  const tz = state.data.settings.budget.timezone;
  const today = todayISO(tz);
  calState = { month: calState.month || today.slice(0, 7), day: calState.day || today, ...patch };
  openModal({
    title: "吃的日历",
    body: calendarBody(state, calState),
    okText: "关闭"
  });
}

function calShiftMonth(delta) {
  const [y, m] = String(calState.month || "").split("-").map(Number);
  const next = shiftMonth(y || 2026, m || 1, delta);
  showCalendar({ month: `${next.year}-${String(next.month).padStart(2, "0")}`, day: `${next.year}-${String(next.month).padStart(2, "0")}-01` });
}

// 对调/挪动一天：「拖动」和「点选对调」都走这里，规则在 model.js 的 swapMealDays
function performSwap(dateA, dateB) {
  if (!dateA || !dateB || dateA === dateB) return;
  const check = swapMealDays(state.data, dateA, dateB);
  if (!check.ok) {
    toast(check.reason);
    return;
  }
  const nameOf = (d) => {
    const m = state.data.meals.find((x) => x.date === d);
    const r = m && m.recipeId ? recipesById().get(m.recipeId) : null;
    return r ? r.name : "空的";
  };
  const a = `${dateA.slice(5)} ${nameOf(dateA)}`;
  const b = `${dateB.slice(5)} ${nameOf(dateB)}`;
  state.swapFrom = null;
  mutate((d) => swapMealDays(d, dateA, dateB).data, `对调：${dateA.slice(5)} 与 ${dateB.slice(5)}`);
  toast(`已对调：${a} ↔ ${b}`);
}

// ---- 本周拖动：按住某天右上角的「⠿ 换」拖到另一天 ----
// 用 Pointer 事件（鼠标和触屏同一套）：鼠标从整条日期栏就能拖起来；
// 触屏只从「⠿ 换」拖（那一小块设了 touch-action:none，不会跟页面滚动打架）。
// 没拖动就是普通点击 —— 那会走「点选对调」模式，两条路都能换。
let pendingDrag = null;
let dragActive = null;
let suppressClickUntil = 0;

function beginDrag(date, x, y) {
  const card = document.querySelector(`.day-card[data-day="${date}"]`);
  const body = card ? card.querySelector(".day-body") : null;
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.textContent = ((body ? body.textContent : "") || "这道菜").trim().slice(0, 22);
  document.body.appendChild(ghost);
  dragActive = { date, ghost, target: null };
  if (card) card.classList.add("dragging");
  document.body.classList.add("dragging-day");
  state.swapFrom = null; // 拖动和点选模式别同时开着
  moveDrag(x, y);
}

function moveDrag(x, y) {
  if (!dragActive) return;
  dragActive.ghost.style.left = `${x}px`;
  dragActive.ghost.style.top = `${y}px`;
  const el = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
  const card = el && el.closest ? el.closest("[data-day]") : null;
  const ok = !!(card && card.dataset.drop === "1" && card.dataset.day !== dragActive.date);
  if (dragActive.target) dragActive.target.classList.remove("drop-target");
  dragActive.target = ok ? card : null;
  if (dragActive.target) dragActive.target.classList.add("drop-target");
}

function endDrag(commit) {
  if (!dragActive) return;
  const { date, ghost, target } = dragActive;
  ghost.remove();
  if (target) target.classList.remove("drop-target");
  const src = document.querySelector(`.day-card[data-day="${date}"]`);
  if (src) src.classList.remove("dragging");
  document.body.classList.remove("dragging-day");
  dragActive = null;
  suppressClickUntil = Date.now() + 400; // 拖完那一下的 click 别再触发「点选对调」
  if (commit && target) performSwap(date, target.dataset.day);
}

document.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const handle = e.target.closest ? e.target.closest("[data-drag-handle]") : null;
  if (!handle) return;
  const actionEl = e.target.closest("[data-action]");
  const grip = !!(actionEl && actionEl.classList.contains("drag-grip"));
  if (actionEl && !grip) return; // 「做完 / 换」这些按钮照常点
  if (e.pointerType !== "mouse" && !grip) return; // 手机上只从「⠿ 换」拖
  pendingDrag = { date: handle.getAttribute("data-drag-handle"), x: e.clientX, y: e.clientY, id: e.pointerId };
});

document.addEventListener(
  "pointermove",
  (e) => {
    if (dragActive) {
      moveDrag(e.clientX, e.clientY);
      return;
    }
    if (!pendingDrag || e.pointerId !== pendingDrag.id) return;
    const dx = e.clientX - pendingDrag.x;
    const dy = e.clientY - pendingDrag.y;
    if (dx * dx + dy * dy < 16) return; // 4px 以内还算点击
    const date = pendingDrag.date;
    pendingDrag = null;
    beginDrag(date, e.clientX, e.clientY);
  },
  { passive: true }
);

document.addEventListener("pointerup", () => {
  pendingDrag = null;
  endDrag(true);
});
document.addEventListener("pointercancel", () => {
  pendingDrag = null;
  endDrag(false);
});
// 拖到一半窗口失焦（切出去 / 系统弹窗）不会再有 pointerup，这里收尾，别留下幽灵
window.addEventListener("blur", () => {
  pendingDrag = null;
  endDrag(false);
});

const handlers = {
  "pick-recipe": (el) => openRecipePicker(el.dataset.date),
  "picker-cat": (el) => openRecipePicker(picker.date, { category: el.dataset.cat || "", limit: 30 }),
  "picker-more": () => openRecipePicker(picker.date, { limit: (picker.limit || 30) + 30 }),
  "picker-pick": (el) => {
    const r = recipesById().get(el.dataset.recipe);
    const name = r ? r.name : el.dataset.recipe;
    const sv = readServings(document, "picker-servings", picker.servings || state.data.settings.household.defaultServings);
    mutate(
      (d) =>
        upsertMeal(d, el.dataset.date, {
          state: "planned",
          recipeId: el.dataset.recipe,
          actualServings: sv,
          servingsConfirmed: true
        }),
      `安排：${name}`
    );
    closeModal();
    toast(`已安排：${name} · ${sv} 人份`);
  },
  "day-actions": (el) => showDayActions(el.dataset.date),
  "day-set": (el) => {
    mutate((d) => upsertMeal(d, el.dataset.date, { state: el.dataset.state }), `改状态：${el.dataset.state}`);
    closeModal();
  },
  "day-clear": (el) => {
    mutate((d) => removeMeal(d, el.dataset.date), "清空这天");
    closeModal();
  },
  "clear-meal": (el) => mutate((d) => removeMeal(d, el.dataset.date)),
  "set-meal": (el) => mutate((d) => upsertMeal(d, el.dataset.date, { state: el.dataset.state })),
  "cook-meal": (el) => cookMealAction(el.dataset.date),
  "add-recipe": () => addRecipe(),
  "publish-recipe": (el) => {
    const r = recipesById().get(el.dataset.id);
    if (!r) return;
    if (!r.ingredients.length) {
      toast("这道还没补全，等电脑补全后再发布");
      return;
    }
    mutate((d) => publishRecipe(d, r.id), `发布食谱：${r.name}`);
    toast("已发布，可以排进本周了");
  },
  "publish-all-drafts": () => {
    const ready = state.data.recipes.filter((r) => r.status === "draft" && r.ingredients.length > 0);
    if (!ready.length) {
      toast("没有可发布的草稿");
      return;
    }
    openModal({
      title: `发布这 ${ready.length} 道菜？`,
      body: "<p class=\"muted\">发布后就能直接排进本周；不想要的可以随时在食谱库里删掉。</p>",
      okText: "全部发布",
      onOk: () => {
        mutate((d) => {
          let next = d;
          for (const r of ready) next = publishRecipe(next, r.id);
          return next;
        }, `发布 ${ready.length} 道菜谱`);
        toast(`已发布 ${ready.length} 道`);
      }
    });
  },
  "delete-recipe": (el) => {
    const r = recipesById().get(el.dataset.id);
    if (!r) return;
    const check = removeRecipe(state.data, r.id);
    if (!check.ok) {
      toast(check.reason);
      return;
    }
    openModal({
      title: `删掉「${r.name}」？`,
      body: '<p class="muted">只是从食谱库移除，不影响库存和购买记录。</p>',
      okText: "删除",
      onOk: () => mutate((d) => removeRecipe(d, r.id).data, `删除食谱：${r.name}`)
    });
  },
  "open-recipe": (el) => openRecipe(el.dataset.id),
  "edit-recipe-ingredients": (el) => editRecipeIngredients(el.dataset.id),
  "show-more-recipes": () => {
    state.recipeLimit = (state.recipeLimit || 30) + 30;
    render();
  },
  "pick-category": (el) => {
    state.recipeCategory = el.dataset.cat || "";
    state.recipeLimit = 30;
    render();
  },
  "all-suggestions": () => showAllSuggestions({ reset: true }),
  "all-suggestions-more": () => showAllSuggestions({ limit: suggestState.limit + 30 }),
  "fridge-group": (el) => {
    const area = el.dataset.area;
    state.fridgeHidden = { ...(state.fridgeHidden || {}), [area]: !(state.fridgeHidden || {})[area] };
    render();
  },
  "suggest-week": () => showWeekPlan(Math.floor(Math.random() * 100000) + 1),
  "optimize-week": () => {
    optimizePatch = { fillEmpty: true, purge: false };
    showOptimizeWeek();
  },
  "calendar-open": () => {
    calState = { month: null, day: null };
    showCalendar();
  },
  "week-prev": () => {
    state.weekStart = shiftWeek(viewedWeekStart(), -1);
    state.swapFrom = null;
    render();
  },
  "week-next": () => {
    state.weekStart = shiftWeek(viewedWeekStart(), 1);
    state.swapFrom = null;
    render();
  },
  "week-today": () => {
    state.weekStart = null;
    state.swapFrom = null;
    render();
  },
  // 从「吃的日历」跳到某一周去排：日历是回看的，但也能顺手去那一周安排
  "cal-goto": (el) => {
    state.weekStart = weekStartISO(String(el.dataset.date || todayISO(state.data.settings.budget.timezone)), state.data.settings.budget.weekStartsOn);
    state.tab = "week";
    closeModal();
    render();
  },
  "cal-prev": () => calShiftMonth(-1),
  "cal-next": () => calShiftMonth(1),
  "cal-today": () => {
    const today = todayISO(state.data.settings.budget.timezone);
    showCalendar({ month: today.slice(0, 7), day: today });
  },
  "cal-pick": (el) => showCalendar({ month: String(el.dataset.date).slice(0, 7), day: el.dataset.date }),
  "swap-start": (el) => {
    state.swapFrom = el.dataset.date;
    render();
    toast("点另一天的「⇄ 换到这天」完成对调");
  },
  "swap-cancel": () => {
    state.swapFrom = null;
    render();
  },
  "swap-target": (el) => performSwap(state.swapFrom, el.dataset.date),
  "reroll-week": () => showWeekPlan(weekPlanSeed + 1),
  "suggest-day": (el) => {
    daySugState = freshDaySug(null);
    showDaySuggestion(el.dataset.date);
  },
  "reroll-day": (el) => {
    if (daySugState.pickId) daySugState.rejected.push(daySugState.pickId);
    daySugState.seenBackups = []; // 换了主推，备选重新来过
    daySugState.backupSeed = Math.floor(Math.random() * 100000) + 1;
    showDaySuggestion(el.dataset.date);
  },
  "reroll-day-backups": (el) => {
    // 把这一批记下来，下一批不再出现它们
    daySugState.seenBackups.push(...(daySugState.backupIds || []));
    showDaySuggestion(el.dataset.date);
  },
  "preview-day-pick": (el) => showDaySuggestion(el.dataset.date, { forceId: el.dataset.recipe }),
  "add-to-week": (el) => addToWeek(el.dataset.id),
  "edit-purchase": (el) => editPurchase(el.dataset.purchase),
  "undo-purchase": (el) => undoPurchaseAction(el.dataset.purchase),
  "undo-cook": (el) => undoCookAction(el.dataset.date),
  "price-history": (el) => showPriceHistory(el.dataset.food),
  "adopt-price": (el) => {
    const foodId = el.dataset.food;
    const h = foodPriceHistory(state.data, foodId);
    if (!h.latest) return;
    mutate((d) => setFoodPack(d, foodId, { size: h.latest.quantity, unit: h.latest.unit, pricePence: h.latest.amountPence }), "更新参考价");
    toast("已按最近一次购买更新参考价");
  },
  "inv-add": () => addInventory(),
  "food-batches": (el) => showFoodBatches(el.dataset.food),
  "pending-prices": () => showPendingPrices(),
  "mark-free": (el) => {
    const ids = String(el.dataset.purchases || "").split(",").filter(Boolean);
    if (!ids.length) return;
    mutate(
      (d) => ids.reduce((next, id) => setPurchasePrice(next, id, null, "stock"), d),
      `标记没花钱（${ids.length} 笔）`
    );
    toast(`已标记 ${ids.length} 笔为「库存·没花钱」`);
    showPendingPrices();
  },
  "food-prices": () => showFoodPrices({ reset: true, mode: "all" }),
  "date-preset": (el) => {
    const prefix = el.dataset.target;
    if (el.dataset.mode === "estimate") {
      fillEstimatedDate(prefix);
      return;
    }
    const dateInput = document.getElementById(`${prefix}-date`);
    const addedEl = dateInput && dateInput.dataset.addedSel ? document.querySelector(dateInput.dataset.addedSel) : null;
    const base = (addedEl && addedEl.value) || todayISO(state.data.settings.budget.timezone);
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + Number(el.dataset.days || 7));
    dateInput.value = d.toISOString().slice(0, 10);
    dateInput.dataset.source = "package"; // 自己选的，就按你定的算
    const hint = document.getElementById(`${prefix}-date-hint`);
    if (hint) hint.textContent = `按 ${base} 往后 ${el.dataset.days} 天算：${dateInput.value}。`;
  },
  "fill-expiry": () => {
    const today = todayISO(state.data.settings.budget.timezone);
    const fById = foodsById();
    let n = 0;
    mutate((d) => {
      const batches = d.inventoryBatches.map((b) => {
        if (b.date || (b.dateType && b.dateType !== "unknown")) return b;
        const est = estimateBatchDates(fById.get(b.foodId), { addedAt: b.addedAt || today, location: b.location });
        if (!est) return b;
        n += 1;
        return { ...b, ...est };
      });
      return { ...d, inventoryBatches: batches };
    }, "按保鲜期补到期日");
    toast(n ? `给 ${n} 条库存补了估算到期日` : "没有需要补的");
  },
  "food-prices-filter": (el) => showFoodPrices({ filter: el.dataset.filter, limit: 40 }),
  "food-prices-more": () => showFoodPrices({ limit: priceBook.limit + 40 }),
  "dish-price": (el) => showDishPrice(el.dataset.id, Number(el.dataset.servings)),
  "set-ref-price": (el) =>
    setRefPrice(el.dataset.food, {
      from: el.dataset.from,
      dish: el.dataset.dish,
      servings: Number(el.dataset.servings)
    }),
  "inv-edit": (el) => editInventory(el.dataset.id),
  "inv-del": (el) => {
    const b = state.data.inventoryBatches.find((x) => x.id === el.dataset.id);
    if (!b) return;
    const f = foodsById().get(b.foodId);
    // 不弹确认：冰箱里删一条是高频操作，点错可以去「我的 → 操作日志」回到上一版
    mutate((d) => removeBatch(d, b.id), `删除库存：${f ? f.name : b.foodId}`);
    toast(`已删除：${f ? f.name : b.foodId}${b.quantity ? ` ${b.quantity}${b.unit || ""}` : ""}`);
  },
  "save-settings": () => saveSettings(),
  "goto-tab": (el) => {
    state.tab = el.dataset.tab;
    render();
  },
  "save-config": () => saveSyncConfig(),
  "sync-read": () => readRemote(),
  "sync-write": () => writeRemote(),
  "load-log": () => loadLog(),
  "make-save": () => showSaveText(),
  "load-save": () => showLoadText(),
  "restore-backup": () =>
    openModal({
      title: "恢复这份本机备份？",
      body: '<p class="muted">会把数据换成备份那一份并写回远端。恢复前当前数据会再自动备份一次，随时能退回来。</p>',
      okText: "恢复",
      onOk: () => {
        restoreBackup().then((res) => toast(res.ok ? "已恢复备份，正在写入远端" : res.reason));
      }
    }),
  "restore-commit": (el) =>
    openModal({
      title: `回到 ${String(el.dataset.sha).slice(0, 7)}？`,
      body: '<p class="muted">会把当前数据换成那一版，并写成一条新提交。历史都保留着，随时可以再回到更新的版本。</p>',
      okText: "回到这版",
      onOk: () => restoreCommit(el.dataset.sha)
    }),
  "resolve-conflict": (el) => resolveConflictAt(el.dataset.path, el.dataset.choice)
};

document.addEventListener("click", (e) => {
  if (Date.now() < suppressClickUntil) return; // 刚拖完，这一下不算点击
  // 单选胶囊：点一下选中，顺手改掉隐藏域的值
  const chip = e.target.closest("[data-radio]");
  if (chip) {
    e.preventDefault();
    const group = chip.parentElement;
    for (const b of group.querySelectorAll("[data-radio]")) b.classList.toggle("active", b === chip);
    const input = document.getElementById(chip.dataset.radio);
    if (input) input.value = chip.dataset.value;
    return;
  }
  const el = e.target.closest("[data-action]");
  if (!el || el.dataset.action === "buy-item") return;
  const fn = handlers[el.dataset.action];
  if (fn) {
    e.preventDefault();
    fn(el);
  }
});

document.addEventListener("change", (e) => {
  const el = e.target.closest('[data-action="buy-item"]');
  if (el) buyItem(el.dataset.key, el);
});


// 搜索食谱：输入后稍等一下再重渲染，并把光标放回去
let searchTimer = null;
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!el || el.id !== "recipe-search") return;
  state.recipeQuery = el.value;
  state.recipeLimit = 30;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    render();
    const box = document.getElementById("recipe-search");
    if (box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
  }, 250);
});

// 回退键：先关弹窗，再退回上一个 Tab，最外层才退出应用
let exitArmed = false;
let exitTimer = null;

function onPopState(e) {
  const st = e.state || {};
  // 1) 有弹窗就先关弹窗（弹窗自己占一条历史记录）
  if (closeModalsOnBack()) return;
  // 2) 能退回上一个 Tab 就退
  const tabChanged = !!(st.tab && st.tab !== state.tab);
  if (tabChanged) {
    state.tab = st.tab;
    if (state.tab === "me" && !state.log) loadLog();
    render();
  }
  // 3) 已经到最底层了：提示“再按一次退出”，并把栅栏补回去
  const atBottom = st.kind === "home" || !st.app;
  if (!atBottom || tabChanged) return;
  if (exitArmed) {
    // 用户确认过了：放行，真的退出
    try {
      history.back();
    } catch {
      /* 忽略 */
    }
    return;
  }
  exitArmed = true;
  clearTimeout(exitTimer);
  exitTimer = setTimeout(() => {
    exitArmed = false;
  }, 2000);
  toast("再按一次返回退出");
  pushGuard();
}

tabbar.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  if (btn.dataset.tab === state.tab) return;
  state.tab = btn.dataset.tab;
  render();
  if (state.tab === "me" && !state.log) loadLog();
  try {
    history.pushState({ app: true, tab: state.tab, kind: "tab" }, "", "#tab");
  } catch {
    /* 忽略 */
  }
});

subscribe(render);

(async function main() {
  await init();
  // 打开就把没填日期的库存按保鲜期估上（同步一次远端就够，之后靠 mutate 兜底）
  if (state.data && state.data.settings) {
    const boot = backfillBatchDates(state.data, todayISO(state.data.settings.budget.timezone));
    if (boot.filled) await mutate((d) => d, `按保鲜期补 ${boot.filled} 条到期日`);
  }
  render();
  checkForUpdate();
  syncOnOpen();
  // 装到主屏（PWA）：注册一个不做缓存的 Service Worker，满足「可安装」条件。
  // 它不缓存任何东西，联网行为跟以前一样。
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* 注册失败不影响使用 */
    });
  }
})();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkForUpdate();
});
