import { getFile, putFile, listCommits, GitHubError } from "./github.js?v=4d701ad";
import { threeWayMerge } from "../src/rules/merge.js?v=4d701ad";
import { weekRange, todayISO } from "../src/rules/week.js?v=4d701ad";
import { buildValidator, formatErrors } from "../src/rules/validate.js?v=4d701ad";
import { setAtPath } from "../src/rules/resolve.js?v=4d701ad";
import { encodeSave, decodeSave } from "../src/rules/savecode.js?v=4d701ad";
import { backfillBatchDates } from "../src/rules/expiry.js?v=4d701ad";
import { writeOutcome } from "../src/rules/sync.js?v=4d701ad";

const KEYS = { config: "dinning.config", data: "dinning.data", meta: "dinning.meta" };
const BACKUP_KEY = "dinning.backup";

// 空档：第一次打开（本机和远端都还没有数据）时用，保证界面能正常渲染
function emptyDocument() {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    settings: {
      household: { defaultServings: 2 },
      budget: { weeklyPence: 5000, weekStartsOn: "saturday", timezone: "Europe/London" },
      stores: [
        { id: "aldi", name: "Aldi", role: "main" },
        { id: "lanjing", name: "蓝鲸（中超）", role: "main" },
        { id: "sainsburys", name: "Sainsbury's", role: "topup" }
      ]
    },
    foods: [],
    recipes: [],
    meals: [],
    inventoryBatches: [],
    purchases: [],
    cookLogs: [],
    stockLedger: [],
    deletions: []
  };
}

// 本机存储：优先 IndexedDB；用不了（file:// 打开的单文件版、隐私模式）就退回 localStorage。
// 试用的朋友常常是「微信里收到一个 html 直接打开」，那条路上 IndexedDB 可能不可用。
let idbPromise = null;
let idbBroken = false;
function db() {
  if (idbBroken) return Promise.reject(new Error("IndexedDB 不可用"));
  if (!idbPromise) {
    idbPromise = window.idb.openDB("dinning", 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      }
    });
  }
  return idbPromise;
}

function localRead(k) {
  try {
    const raw = window.localStorage.getItem(k);
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function localWrite(k, v) {
  try {
    window.localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* 存不下就算了，至少别让界面崩 */
  }
}

async function kvGet(k) {
  try {
    return await (await db()).get("kv", k);
  } catch {
    idbBroken = true;
    return localRead(k);
  }
}

async function kvSet(k, v) {
  try {
    return await (await db()).put("kv", v, k);
  } catch {
    idbBroken = true;
    localWrite(k, v);
  }
}

let validatorPromise = null;
function getValidator() {
  if (!validatorPromise) {
    validatorPromise = (async () => {
      let schema = null;
      try {
        // no-store：schema 也必须每次拿最新版，否则新加的字段会被旧 schema 判成非法
        const res = await fetch("../schema/data.schema.json", { cache: "no-store" });
        schema = await res.json();
      } catch {
        // 单文件试用版（file:// 打开）取不到外链 schema：用内联的那份
        schema = window.__DINNING_SCHEMA__ || null;
      }
      if (!schema) throw new Error("拿不到 schema");
      return buildValidator(window.Ajv, schema);
    })();
  }
  return validatorPromise;
}

export const state = {
  data: null,
  config: { owner: "Telon-Y", repo: "Dinning", branch: "main", path: "data.json", token: "" },
  sha: null,
  base: null,
  rev: 0, // 本地数据版本号：每次 mutate +1，用来发现「同步期间又改了」
  conflictBase: null, // 这轮冲突是跟哪个远端版本比出来的
  conflictSha: null,
  status: "加载中",
  statusKind: "",
  message: "",
  conflicts: [],
  pending: false,
  labels: [],
  log: null,
  backup: null,
  recipeQuery: "",
  recipeCategory: "",
  recipeLimit: 30,
  suggestLimit: 8,
  swapFrom: null, // 「点选对调」模式下要从哪天开始换
  weekStart: null, // 「本周」在看哪一周：null = 本周本身，否则是那一周的起点（可以往未来排）
  tab: "week"
};

const listeners = new Set();
export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export function emit() {
  for (const fn of listeners) fn();
}

function setStatus(status, message = "", kind = "") {
  state.status = status;
  state.message = message;
  state.statusKind = kind;
  emit();
}

export function currentRange(data) {
  const tz = data.settings.budget.timezone;
  return weekRange(todayISO(tz), data.settings.budget.weekStartsOn);
}

function summarize(data) {
  return `食谱 ${data.recipes.length} · 菜单 ${data.meals.length} · 库存 ${data.inventoryBatches.length} · 购买 ${data.purchases.length}`;
}

async function persist() {
  if (state.data) await kvSet(KEYS.data, state.data);
  await kvSet(KEYS.meta, { sha: state.sha, base: state.base, pending: state.pending, labels: state.labels });
}

// 旧版（M0 同步验证页）把配置存在 dinning-m0 / github。这里读一次迁移过来，省得重新输 Token。
async function legacyConfig() {
  try {
    if (!indexedDB.databases) return null;
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === "dinning-m0")) return null;
    const old = await new Promise((resolve, reject) => {
      const req = indexedDB.open("dinning-m0");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    let cfg = null;
    if (old.objectStoreNames.contains("kv")) {
      cfg = await new Promise((resolve, reject) => {
        const tx = old.transaction("kv", "readonly");
        const r = tx.objectStore("kv").get("github");
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => reject(r.error);
      });
    }
    old.close();
    return cfg;
  } catch {
    return null;
  }
}

export async function init() {
  const [config, data, meta] = await Promise.all([kvGet(KEYS.config), kvGet(KEYS.data), kvGet(KEYS.meta)]);
  if (config) {
    state.config = { ...state.config, ...config };
  } else {
    const legacy = await legacyConfig();
    if (legacy && legacy.token) {
      state.config = { ...state.config, ...legacy };
      await kvSet(KEYS.config, state.config);
    }
  }
  if (data) state.data = data;
  // 本机完全没数据过（第一次打开、又拉不到远端）：
  // 单文件试用版会带一份初始食谱库，其它情况给一份空档，
  // 免得界面去读 state.data.settings 直接抛异常，整个初始化中断。
  if (!state.data) {
    const seed = window.__DINNING_SEED__;
    state.data = seed ? structuredClone(seed) : emptyDocument();
    if (seed) state.seeded = true;
  }
  if (meta) {
    state.sha = meta.sha || null;
    state.base = meta.base || null;
    state.pending = !!meta.pending;
    state.labels = Array.isArray(meta.labels) ? meta.labels : [];
  }
  if (window.__DINNING_STANDALONE__ && !state.config.token) {
    setStatus(state.seeded ? "试用版" : "未连接", "试用版：数据只存在这台设备上，不会同步到任何仓库", "warn");
  } else if (!state.config.token) setStatus("未连接", "去「我的」填 Token，之后自动读写", "warn");
  else if (state.pending) setStatus("待同步", "有改动没推上去，正在自动推送…", "warn");
  else if (state.data) setStatus("本地副本", "正在拉取最新版…", "warn");
  else setStatus("同步中", "正在拉取远端数据…", "warn");
  await loadBackupInfo();
  emit();
}

export async function saveConfig(patch) {
  state.config = { ...state.config, ...patch };
  await kvSet(KEYS.config, state.config);
  emit();
}

export async function mutate(fn, label) {
  if (!state.data) return;
  state.data = fn(structuredClone(state.data));
  // 顺手把没填日期的库存按保鲜期估上：不用你一条条手动保存
  const back = backfillBatchDates(state.data, todayISO(state.data.settings.budget.timezone));
  if (back.filled) state.data = back.data;
  state.rev = (state.rev || 0) + 1; // 本地版本号：同步期间又改了就靠它发现
  if (label && !state.labels.includes(label)) state.labels.push(label);
  if (state.labels.length > 5) state.labels = state.labels.slice(-5);
  state.pending = true;
  state.status = "待同步";
  state.statusKind = "warn";
  // 本地也先校验一遍：别等推到远端才发现格式不对
  try {
    const validate = await getValidator();
    if (!validate(state.data)) {
      const errs = formatErrors(validate).slice(0, 3).join("；");
      setStatus("格式错误", `这次改动不合 schema（已存本机，暂时不会推远端）：${errs}`, "bad");
    }
  } catch {
    /* 校验器加载失败就不拦 */
  }
  await persist();
  emit();
  schedulePush();
}

function handleErr(e, phase) {
  let msg;
  if (e instanceof GitHubError) {
    if (e.status === 401) msg = "401 未授权：检查 Token 是否有效、是否勾了 Contents 读写";
    else if (e.status === 403) msg = "403 权限不足或触发限流";
    else if (e.status === 404) msg = "404 找不到仓库或路径：检查 owner / repo / path 与 Token 授权范围";
    else msg = `${e.status} ${e.body}`;
  } else {
    msg = e && e.message ? e.message : String(e);
  }
  setStatus(`${phase}失败`, msg, "bad");
}

export async function readRemote() {
  try {
    setStatus("读取中…");
    const res = await getFile(state.config);
    if (!res.exists) {
      setStatus("远端为空", "远端还没有 data.json", "warn");
      return;
    }
    const changed = res.content !== state.base;
    const parsed = JSON.parse(res.content);
    state.data = parsed;
    state.sha = res.sha;
    state.base = res.content;
    state.conflicts = [];
    await persist();
    const info = summarize(parsed);
    setStatus("已同步", changed ? `已更新：${info}` : `远端没有变化：${info}`, "good");
  } catch (e) {
    handleErr(e, "读取");
  }
}

export async function writeRemote() {
  if (!state.data) return;
  try {
    setStatus("写入中…");
    const validate = await getValidator();
    if (!validate(state.data)) {
      setStatus("格式错误", "数据不符合 schema，已阻止写入：" + formatErrors(validate).slice(0, 3).join("；"), "bad");
      return;
    }
    const rev = state.rev || 0; // 这次上传的是哪个版本
    const content = JSON.stringify(state.data, null, 2) + "\n";
    const message = state.labels.length ? `Dinning：${state.labels.join("；")}` : "更新 data.json";
    const res = await putFile(state.config, content, state.sha, message);
    if (res.conflict) {
      await mergeAndPush();
      return;
    }
    state.sha = res.sha;
    state.base = content;
    // 请求期间本地又改了：上传的那份已经不是最新的，绝不能标成「已同步」，
    // 也不能用旧内容覆盖 state.data —— 继续保留待同步，稍后再推一次。
    if (writeOutcome({ snapshotRev: rev, currentRev: state.rev }).changedDuringWrite) {
      await persist();
      setStatus("待同步", "同步期间又改了，正在再推一次", "warn");
      schedulePush(200);
      return;
    }
    state.pending = false;
    state.labels = [];
    await persist();
    setStatus("已同步", `已写入远端：${summarize(state.data)}`, "good");
  } catch (e) {
    handleErr(e, "写入");
  }
}

async function mergeAndPush() {
  const rev = state.rev || 0;
  const latest = await getFile(state.config);
  if (!latest.exists) {
    setStatus("同步失败", "远端文件不见了", "bad");
    return;
  }
  if (!state.base) {
    setStatus("需人工处理", "没有同步基线，先「读取远端」再改", "warn");
    return;
  }
  // 用「此刻」的本地数据合并：等远端的这段时间里可能又改过
  const local = state.data;
  const { merged, conflicts } = threeWayMerge(JSON.parse(state.base), local, JSON.parse(latest.content));
  state.conflicts = conflicts;
  // 记住这次冲突是跟哪个远端版本比出来的，解决冲突时要把基线推进到它
  state.conflictBase = latest.content;
  state.conflictSha = latest.sha;
  if (conflicts.length) {
    setStatus("需人工处理", `${conflicts.length} 处冲突，已保留双方`, "warn");
    return;
  }
  const content = JSON.stringify(merged, null, 2) + "\n";
  const res2 = await putFile(state.config, content, latest.sha, "三方自动合并");
  if (res2.conflict) {
    setStatus("待同步", "写入时远端又变了，请重试", "warn");
    return;
  }
  state.sha = res2.sha;
  state.base = content;
  if (writeOutcome({ snapshotRev: rev, currentRev: state.rev }).changedDuringWrite) {
    // 合并/写入期间又改了：把这次写入的合并结果当作新基线，本地改动继续保留，再推一次
    await persist();
    setStatus("待同步", "同步期间又改了，正在再推一次", "warn");
    schedulePush(200);
    return;
  }
  state.data = merged;
  state.pending = false;
  state.labels = [];
  await persist();
  setStatus("已同步", `已自动合并并写入：${summarize(state.data)}`, "good");
}

// ---- 自动同步 ----
let pushTimer = null;
let pushInFlight = false;
let pushAgain = false;

function schedulePush(delay = 1500) {
  if (!state.config.token || !state.data) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    autoPush();
  }, delay);
}

async function autoPush() {
  if (pushInFlight) {
    pushAgain = true;
    return;
  }
  pushInFlight = true;
  try {
    await writeRemote();
  } finally {
    pushInFlight = false;
    if (pushAgain) {
      pushAgain = false;
      schedulePush(500);
    }
  }
}

// 页面打开时：本地有没推上去的改动就先推，否则直接拉最新。
export function syncOnOpen() {
  if (!state.config.token) return;
  // 有冲突时不要再自动推送：否则每次打开都在重试同一个冲突，永远读不到远端的新数据。
  if ((state.conflicts || []).length) {
    setStatus("需人工处理", "有冲突等你选；也可以点「读取远端」放弃本地改动、直接用远端版本", "warn");
    return;
  }
  if (state.pending) autoPush();
  else readRemote();
}

export async function loadLog() {
  try {
    state.log = await listCommits(state.config, { path: state.config.path, perPage: 20 });
    emit();
  } catch (e) {
    handleErr(e, "读取日志");
  }
}

// 回退到某一版：拿那一版的内容当当前数据，用最新 SHA 写回，形成一条新提交，历史不丢。
export async function restoreCommit(sha) {
  try {
    setStatus("读取中…", `正在回到 ${String(sha).slice(0, 7)}`);
    const [old, latest] = await Promise.all([getFile(state.config, sha), getFile(state.config)]);
    if (!old.exists || !latest.exists) {
      setStatus("回退失败", "这一版或远端当前没有数据文件", "bad");
      return;
    }
    state.data = JSON.parse(old.content);
    state.base = latest.content;
    state.sha = latest.sha;
    state.pending = true;
    state.labels = [`回到 ${String(sha).slice(0, 7)}`];
    await persist();
    emit();
    await autoPush();
  } catch (e) {
    handleErr(e, "回退");
  }
}

// 处理一处冲突：按选择把值换成我的或远端的，解决完最后一处就自动写回。
export async function resolveConflictAt(path, choice) {
  const conflict = (state.conflicts || []).find((c) => c.path === path);
  if (!conflict) return;
  const value = choice === "remote" ? conflict.remote : conflict.local;
  state.data = setAtPath(state.data, path, value === undefined ? null : value, {
    deleteIfNull: conflict.kind === "delete-vs-modify"
  });
  state.conflicts = state.conflicts.filter((c) => c.path !== path);
  state.rev = (state.rev || 0) + 1;
  // 冲突是拿某个远端版本比出来的：解决完就把它当成新基线，
  // 否则下一次写入还会拿旧基线去比，同一处冲突又冒出来。
  if (state.conflictBase) {
    state.base = state.conflictBase;
    if (state.conflictSha) state.sha = state.conflictSha;
    state.conflictBase = null;
    state.conflictSha = null;
  }
  state.pending = true;
  if (!state.labels.includes("解决冲突")) state.labels.push("解决冲突");
  await persist();
  if (state.conflicts.length === 0) {
    setStatus("待同步", "冲突已解决，正在写入…", "warn");
    schedulePush(400);
  } else {
    setStatus("需人工处理", `还剩 ${state.conflicts.length} 处冲突`, "warn");
  }
}

// ---- 备份与恢复 ----

// 恢复前把当前数据留在本机一份，随时能退回来。
async function saveBackupLocal() {
  if (!state.data) return;
  const at = new Date().toISOString();
  await kvSet(BACKUP_KEY, { at, data: state.data });
  state.backup = { at, summary: summarize(state.data) };
}

export async function loadBackupInfo() {
  const b = await kvGet(BACKUP_KEY);
  state.backup = b && b.data ? { at: b.at, summary: summarize(b.data) } : null;
}

// 生成存档文本：压缩 + 混淆，能直接复制走。
export function exportSaveText() {
  if (!state.data || !window.LZString) return "";
  return encodeSave(state.data, window.LZString);
}

// 换上一份新数据（导入或恢复备份都走这里）。
// 先把远端最新版当基线，这样写回去是我们这份说了算，不被判成冲突。
async function applyNewData(next, label) {
  try {
    const latest = await getFile(state.config);
    if (latest.exists) {
      state.sha = latest.sha;
      state.base = latest.content;
    }
  } catch {
    /* 拿不到远端就按现有 SHA 写，真冲突了再走合并 */
  }
  state.data = next;
  state.pending = true;
  state.labels = [label];
  state.conflicts = [];
  await persist();
  emit();
  await autoPush();
}

// 粘贴读档：解出存档 → 校验格式 → 自动备份当前数据 → 换上去并写回远端。
export async function importSaveText(text) {
  if (!window.LZString) return { ok: false, reason: "压缩库没加载起来，刷新页面再试" };
  const decoded = decodeSave(text, window.LZString);
  if (!decoded.ok) return decoded;
  let validate;
  try {
    validate = await getValidator();
  } catch {
    return { ok: false, reason: "校验器没加载起来，稍后再试" };
  }
  if (!validate(decoded.data)) {
    return { ok: false, reason: "存档里的数据格式不符合要求，已拒绝：" + formatErrors(validate).slice(0, 3).join("；") };
  }
  await saveBackupLocal();
  await applyNewData(decoded.data, "粘贴读档");
  return { ok: true };
}

export async function restoreBackup() {
  const b = await kvGet(BACKUP_KEY);
  if (!b || !b.data) return { ok: false, reason: "还没有自动备份" };
  const target = b.data;
  await saveBackupLocal(); // 当前这份变成新的备份，可以再退回来
  await applyNewData(target, "恢复备份");
  return { ok: true };
}
