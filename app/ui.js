export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let modalRoot = null;
export function mountModals(root) {
  modalRoot = root;
}

// 弹窗序号：用来判断“我这一层”是否已经被新弹窗顶替。
// 有些按钮会先打开新弹窗、再由这一层收尾，不能把新弹窗一起关掉。
let modalSeq = 0;
// 当前这一摞弹窗是否往历史里压过一条记录（弹窗套弹窗只压一条）。
let modalPushed = false;
// 最上面那层弹窗的关闭函数，给“点了某个按钮就直接收工”的场景用
let currentClose = null;

function pushModalHistory() {
  if (modalPushed) return;
  modalPushed = true;
  try {
    history.pushState({ modal: true, kind: "modal" }, "", "#modal");
  } catch {
    /* 忽略 */
  }
}

// 主动关掉弹窗时把自己那条历史记录退掉，免得留下“空记录”让返回键失灵
function popModalHistory() {
  if (!modalPushed) return;
  modalPushed = false;
  try {
    if (history.state && history.state.modal) history.back();
  } catch {
    /* 忽略 */
  }
}

export function openModal({ title, body, okText = "确定", cancelText = "取消", dangerText, onOk, onDanger, onMount }) {
  modalSeq += 1;
  const mySeq = modalSeq;
  const stillMine = () => modalSeq === mySeq;
  const nested = !!modalRoot.querySelector(".modal");
  modalRoot.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog">
        <h3>${esc(title)}</h3>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">
          ${dangerText ? `<button class="danger" data-modal="danger">${esc(dangerText)}</button>` : ""}
          <button class="secondary" data-modal="cancel">${esc(cancelText)}</button>
          <button class="primary" data-modal="ok">${esc(okText)}</button>
        </div>
      </div>
    </div>`;
  const close = () => {
    if (!stillMine()) return; // 已经被新弹窗顶替，历史记录交给新弹窗管
    modalRoot.innerHTML = "";
    popModalHistory();
    if (currentClose === close) currentClose = null;
  };
  currentClose = close;
  // 给返回键留一条记录：按返回先关弹窗，而不是直接退出应用
  if (!nested) pushModalHistory();

  modalRoot.querySelector('[data-modal="cancel"]').onclick = close;
  const dangerBtn = modalRoot.querySelector('[data-modal="danger"]');
  if (dangerBtn) {
    dangerBtn.onclick = () => {
      const result = onDanger ? onDanger(modalRoot.querySelector(".modal")) : undefined;
      if (result !== false && stillMine()) close();
    };
  }
  modalRoot.querySelector(".modal-backdrop").onclick = (e) => {
    if (e.target === e.currentTarget) close();
  };
  modalRoot.querySelector('[data-modal="ok"]').onclick = () => {
    const result = onOk ? onOk(modalRoot.querySelector(".modal")) : undefined;
    // 异步的 onOk（校验、解压这类）等出结果再关，避免失败时把用户粘贴的内容弄丢
    if (result && typeof result.then === "function") {
      result
        .then((r) => {
          if (r !== false && stillMine()) close();
        })
        .catch(() => {});
      return false;
    }
    if (result !== false && stillMine()) close();
    return false;
  };
  // 只有明确写了 data-autofocus 的才自动聚焦。
  // 以前是「聚焦第一个输入框」，手机上打开弹窗立刻弹输入法，很烦。
  const input = modalRoot.querySelector("[data-autofocus]");
  if (input) input.focus();
  if (onMount) onMount(modalRoot.querySelector(".modal"));
  return close;
}

// 份数一律用滑块：手机上手指一滑就改，不弹输入法
export function servingsField(id, value, { min = 1, max = 8, label = "做几份" } = {}) {
  const v = Math.max(min, Math.min(max, Number(value) || min));
  return `<div class="slider-field">
    <div class="row between"><span>${esc(label)}</span><b id="${id}-out">${v} 人份</b></div>
    <input id="${id}" type="range" min="${min}" max="${max}" step="1" value="${v}">
    <div class="slider-ticks"><span>${min}</span><span>${max}</span></div>
  </div>`;
}

export function readServings(root, id, fallback) {
  const input = root.querySelector(`#${id}`);
  const n = input ? parseInt(input.value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function bindServings(root, id, onChange) {
  const input = root.querySelector(`#${id}`);
  if (!input) return;
  const out = root.querySelector(`#${id}-out`);
  input.addEventListener("input", () => {
    if (out) out.textContent = `${input.value} 人份`;
    if (onChange) onChange(parseInt(input.value, 10));
  });
}

// 一行单选：选项只有三五个的时候，比下拉少一次点击（点一下就是选中）
export function radioRow({ id, value, choices, name }) {
  return `<div class="radio-row"${name ? ` data-group="${esc(name)}"` : ""}>
    <input type="hidden" id="${id}" value="${esc(value == null ? "" : value)}">
    ${choices
      .map(
        ([v, label]) =>
          `<button type="button" class="chip${v === value ? " active" : ""}" data-radio="${id}" data-value="${esc(v)}">${esc(
            label
          )}</button>`
      )
      .join("")}
  </div>`;
}

// 返回键按下时：关掉当前所有弹窗（它们只占历史里的一条记录）
export function closeModalsOnBack() {
  if (!modalRoot || !modalRoot.querySelector(".modal")) return false;
  modalRoot.innerHTML = "";
  modalPushed = false; // 浏览器已经帮我们退掉那条记录，这里只清状态
  currentClose = null;
  return true;
}

// 代码里主动关弹窗（比如选好菜直接收工）：会把自己那条历史记录一起退掉
export function closeModal() {
  if (!currentClose) return false;
  const close = currentClose;
  currentClose = null;
  close();
  return true;
}

export function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
