/**
 * ui.js —— 通用界面组件（提示条、确认框、动作面板、加载遮罩、图标）。
 *
 * 全部手写、零依赖：这样整个 App 只有一个 HTML + 几个 JS 文件，
 * 不需要 npm install、不需要构建，任何人下载下来双击就能用，
 * 也方便没有前端工程经验的人自己改。
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ------------------------------ 图标 ------------------------------ */

const ICONS = {
  back: 'M15 5l-7 7 7 7',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 13l4 4L19 7',
  camera: 'M4 8h3l2-2h6l2 2h3v11H4z',
  cameraDot: 'M12 16a3.5 3.5 0 100-7 3.5 3.5 0 000 7',
  image: 'M4 5h16v14H4z',
  imageDot: 'M9 10.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3',
  imageLine: 'M5 17l4.5-4.5 3 3L16 12l4 4',
  crop: 'M7 3v14a2 2 0 002 2h14M3 7h14a2 2 0 012 2v14',
  rotate: 'M20.5 12a8.5 8.5 0 11-2.6-6.1M20.5 3.5V9h-5.5',
  filter: 'M4 5h16l-6.2 7.3V19l-3.6-2v-4.7z',
  text: 'M5 6h14M5 11h9M5 16h12',
  file: 'M6 3h8l4 4v14H6z',
  fileFold: 'M14 3v5h5',
  download: 'M12 3v12m0 0l-4.2-4.2M12 15l4.2-4.2M4 19.5h16',
  trash: 'M4 7h16M9.5 7V4h5v3M6.5 7l1 13.5h9L17.5 7',
  share: 'M12 16.5V4m0 0L8 8m4-4l4 4M5 14v6.5h14V14',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  search: 'M10.5 17a6.5 6.5 0 100-13 6.5 6.5 0 000 13M15.5 15.5L20 20',
  sliders: 'M4 7h16M4 12h16M4 17h16',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  sun: 'M12 16.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  contrast: 'M12 3a9 9 0 100 18 9 9 0 000-18M12 3v18',
  edit: 'M4 20h4.2L20 8.2 15.8 4 4 15.8z',
  zoom: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  swap: 'M7 4v13m0 0l-3-3m3 3l3-3M17 20V7m0 0l3 3m-3-3l-3 3',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  eye: 'M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6M12 14.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5',
  folder: 'M3 6h6l2 2.5h10V19H3z',
  zip: 'M6 3h12v18H6zM10 3v3M10 8v3M12 11h2v3h-2z',
  sparkle: 'M12 3l1.9 5.4L19 10l-5.1 1.6L12 17l-1.9-5.4L5 10l5.1-1.6z',
  shield: 'M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z',
  plus2: 'M12 8v8M8 12h8',
};

/**
 * 生成内联 SVG 图标。
 * @param {string} name ICONS 里的名字
 * @param {number} size 像素尺寸
 */
export function icon(name, size = 22) {
  const parts = [name, name + 'Dot', name + 'Line', name + 'Fold']
    .filter((k, i, arr) => ICONS[k] && arr.indexOf(k) === i)
    .map((k) => `<path d="${ICONS[k]}"/>`)
    .join('');
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${parts}</svg>`;
}

/* ------------------------------ 提示条 ------------------------------ */

let toastTimer = null;

/** 底部提示条 */
export function toast(message, type = 'info', ms = 2400) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.className = `toast toast--${type} show`;
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ------------------------------ 加载遮罩 ------------------------------ */

let overlayEl = null;

/**
 * 显示加载遮罩。
 * @param {string} text 文案
 * @param {number|null} progress 0~1，传 null 显示无限旋转
 */
export function showLoading(text = '处理中…', progress = null) {
  if (!overlayEl) {
    overlayEl = document.createElement('div');
    overlayEl.className = 'overlay';
    overlayEl.innerHTML = `
      <div class="overlay__box">
        <div class="spinner"></div>
        <div class="overlay__text"></div>
        <div class="overlay__bar"><i></i></div>
        <div class="overlay__pct"></div>
      </div>`;
    document.body.appendChild(overlayEl);
  }
  overlayEl.classList.add('show');
  overlayEl.querySelector('.overlay__text').textContent = text;
  setProgress(progress);
  return overlayEl;
}

/** 更新遮罩上的进度（0~1；null 表示不确定进度） */
export function setProgress(progress, text) {
  if (!overlayEl) return;
  if (text) overlayEl.querySelector('.overlay__text').textContent = text;
  const bar = overlayEl.querySelector('.overlay__bar');
  const pct = overlayEl.querySelector('.overlay__pct');
  if (progress == null) {
    bar.style.display = 'none';
    pct.textContent = '';
  } else {
    const p = Math.max(0, Math.min(1, progress));
    bar.style.display = 'block';
    bar.querySelector('i').style.width = `${(p * 100).toFixed(1)}%`;
    pct.textContent = `${Math.round(p * 100)}%`;
  }
}

export function hideLoading() {
  if (overlayEl) overlayEl.classList.remove('show');
}

/* ------------------------------ 对话框 ------------------------------ */

function buildModal(html, cls = '') {
  const wrap = document.createElement('div');
  wrap.className = `modal ${cls}`;
  wrap.innerHTML = `<div class="modal__mask"></div><div class="modal__panel">${html}</div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('show'));
  return wrap;
}

function closeModal(wrap) {
  wrap.classList.remove('show');
  setTimeout(() => wrap.remove(), 180);
}

/**
 * 确认框。
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const wrap = buildModal(`
      <h3 class="modal__title">${escapeHtml(title)}</h3>
      ${message ? `<p class="modal__msg">${escapeHtml(message)}</p>` : ''}
      <div class="modal__actions">
        <button class="btn btn--ghost" data-act="cancel">${escapeHtml(cancelText)}</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-act="ok">${escapeHtml(okText)}</button>
      </div>`);
    const done = (v) => {
      closeModal(wrap);
      resolve(v);
    };
    wrap.querySelector('[data-act="cancel"]').onclick = () => done(false);
    wrap.querySelector('[data-act="ok"]').onclick = () => done(true);
    wrap.querySelector('.modal__mask').onclick = () => done(false);
  });
}

/**
 * 输入框弹窗。
 * @returns {Promise<string|null>} 取消返回 null
 */
export function promptDialog({ title, value = '', placeholder = '', okText = '保存', multiline = false }) {
  return new Promise((resolve) => {
    const field = multiline
      ? `<textarea class="input" rows="5" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`
      : `<input class="input" type="text" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" />`;
    const wrap = buildModal(`
      <h3 class="modal__title">${escapeHtml(title)}</h3>
      ${field}
      <div class="modal__actions">
        <button class="btn btn--ghost" data-act="cancel">取消</button>
        <button class="btn btn--primary" data-act="ok">${escapeHtml(okText)}</button>
      </div>`);
    const input = wrap.querySelector('.input');
    setTimeout(() => {
      input.focus();
      if (input.select) input.select();
    }, 60);
    const done = (v) => {
      closeModal(wrap);
      resolve(v);
    };
    wrap.querySelector('[data-act="cancel"]').onclick = () => done(null);
    wrap.querySelector('[data-act="ok"]').onclick = () => done(input.value.trim());
    wrap.querySelector('.modal__mask').onclick = () => done(null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !multiline) done(input.value.trim());
    });
  });
}

/**
 * 底部动作面板（手机上最顺手的多选一交互）。
 * @param {{title?: string, items: Array<{label:string, value:string, icon?:string, danger?:boolean, desc?:string}>}} opts
 * @returns {Promise<string|null>}
 */
export function actionSheet({ title, items }) {
  return new Promise((resolve) => {
    const rows = items
      .map(
        (it) => `
      <button class="sheet__item ${it.danger ? 'is-danger' : ''}" data-value="${escapeHtml(it.value)}">
        ${it.icon ? `<span class="sheet__ico">${icon(it.icon, 20)}</span>` : ''}
        <span class="sheet__label">${escapeHtml(it.label)}${
          it.desc ? `<em class="sheet__desc">${escapeHtml(it.desc)}</em>` : ''
        }</span>
      </button>`
      )
      .join('');
    const wrap = buildModal(`
      ${title ? `<h3 class="modal__title">${escapeHtml(title)}</h3>` : ''}
      <div class="sheet">${rows}</div>
      <button class="btn btn--ghost sheet__cancel" data-value="">取消</button>`, 'modal--sheet');
    const done = (v) => {
      closeModal(wrap);
      resolve(v || null);
    };
    wrap.querySelectorAll('[data-value]').forEach((b) => {
      b.onclick = () => done(b.dataset.value);
    });
    wrap.querySelector('.modal__mask').onclick = () => done(null);
  });
}

/* ------------------------------ 工具函数 ------------------------------ */

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay) return `今天 ${hm}`;
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 触发浏览器下载（手机上会走系统分享/保存） */
export function download(data, filename, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** 复制文本到剪贴板（带兜底方案，兼容非 HTTPS 环境） */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** 轻微震动反馈（安卓/部分浏览器支持，失败静默） */
export function haptic(ms = 12) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* 忽略 */
  }
}

/** 文件名安全化 */
export function safeName(s, fallback = '扫描件') {
  const clean = String(s || '').replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim();
  return clean.slice(0, 60) || fallback;
}
