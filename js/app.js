/**
 * app.js —— 应用主控（路由 + 交互 + 导出）。
 *
 * 整个 App 只有这一个"大脑"：所有界面都是根据 state 渲染出来的普通 DOM，
 * 没有虚拟 DOM、没有框架，方便普通人读懂并且自己改。
 *
 * 数据流：
 *   拍照/导入 → 原图 Blob + 自动检测四角 → 存进 IndexedDB
 *   查看/编辑 → 从原图重新渲染（非破坏性，改多少次都不会变糊）
 *   导出     → PDF / 长图 / JPG压缩包 / 文字
 */

import {
  $,
  $$,
  icon,
  toast,
  showLoading,
  hideLoading,
  setProgress,
  confirmDialog,
  promptDialog,
  actionSheet,
  formatBytes,
  formatDate,
  download,
  copyText,
  haptic,
  safeName,
  escapeHtml,
} from './ui.js';

import { loadImage } from './render.js';
import { saveDoc, loadDoc, listDocs, removeDoc, clearAll, usage, getSettings, setSettings, newId } from './store.js';
import { buildScan, buildFilterPreviews, mergeToLongImage, FILTERS, rotateSource } from './pipeline.js';
import { CropEditor, detectDocument, detectDocumentQuad, rectToQuad, quadToRect, warpPerspective } from './crop.js';
import { buildPDF, buildTextPDF, buildMarkdownPDF } from './pdf.js';
import { parseMarkdown, blocksToPlain, looksStructured, LAYOUT_PROMPT } from './markdown.js';
import { buildDOCX } from './docx.js';
import { buildZip } from './zip.js';
import { recognize, OCR_LANGS, terminate as ocrTerminate } from './ocr.js';
import { recognizeOnline, recognizeViaServer, onlineTarget, probeServer, hasKey, testKey, AI_MODELS, DEFAULT_MODEL } from './ai.js';
import { CameraView, describeCameraError } from './camera.js';

/* ================================================================== */
/* 全局状态                                                            */
/* ================================================================== */

const state = {
  view: 'home', // home | doc | crop | ocr | settings
  docs: [],
  query: '',
  doc: null,
  index: 0,
  settings: getSettings(),
  busy: false,
  // 本站服务端的能力（有没有开通免费在线识别）。启动时探一次；探不到就等于
  // "没有这个能力"，相关 UI 自动缺席，而不是摆一个点了会报错的按钮。
  caps: { serverAi: false, model: '', limits: null },
};

const appEl = $('#app');
const topbarEl = $('#topbar');
const viewEl = $('#view');
const cameraEl = $('#camera');
const fileInput = $('#file-input');

/** 原图解码缓存（ImageBitmap 很占内存，只留最近 4 张） */
const bitmapCache = new Map();
const BITMAP_MAX = 4;

/** 渲染结果缓存：key = 页面 id + 修改版本号 */
const renderCache = new Map();
const RENDER_MAX = 8;

/** Blob → objectURL 复用，避免同一张缩略图反复创建 URL */
const urlCache = new WeakMap();
function blobUrl(blob) {
  if (!blob) return '';
  let u = urlCache.get(blob);
  if (!u) {
    u = URL.createObjectURL(blob);
    urlCache.set(blob, u);
  }
  return u;
}

/**
 * 自动识别纸张四角，返回归一化四边形（找不到就返回 null）。
 *
 * 优先用 detectDocumentQuad：手机拍照时纸多半是歪的，它能给出紧贴纸张的
 * 四个角，透视变换后纸就正了；detectDocument 那个轴对齐矩形只在
 * "纸本来就摆得很正"时才好用，歪着拍会把一圈桌面背景框进来。
 */
function autoDetectQuad(source) {
  try {
    const found = detectDocumentQuad(source);
    if (found?.quad) return found.quad;
  } catch {
    /* 退回到矩形检测 */
  }
  try {
    const rect = detectDocument(source);
    if (rect) return rectToQuad(rect);
  } catch {
    /* 都不行就不裁 */
  }
  return null;
}

function cacheSet(map, key, value, max, onEvict) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const k = map.keys().next().value;
    const v = map.get(k);
    map.delete(k);
    onEvict?.(v, k);
  }
}

/* ================================================================== */
/* 页面渲染：原图 → 扫描件                                            */
/* ================================================================== */

/** 取页面的原图位图（带 LRU 缓存） */
async function getBitmap(page) {
  if (bitmapCache.has(page.id)) {
    const b = bitmapCache.get(page.id);
    cacheSet(bitmapCache, page.id, b, BITMAP_MAX);
    return b;
  }
  const bmp = await loadImage(page.source);
  cacheSet(bitmapCache, page.id, bmp, BITMAP_MAX, (v) => v?.close?.());
  return bmp;
}

function pageKey(page) {
  return `${page.id}|${page._rev || 0}`;
}

/** 渲染预览图（限制在 1600px，手机上滚动/翻页才跟得上手速） */
async function renderPreview(page, force = false) {
  const key = pageKey(page) + '|pv';
  if (!force && renderCache.has(key)) return renderCache.get(key);
  const bmp = await getBitmap(page);
  const { blob } = await buildScan(bmp, {
    rotation: page.rotation || 0,
    quad: page.quad,
    filter: page.filter,
    maxSize: 1600,
    quality: 0.86,
    withThumb: false,
  });
  cacheSet(renderCache, key, blob, RENDER_MAX);
  return blob;
}

/** 渲染导出用的成品（按设置里的清晰度） */
async function renderFull(page) {
  const bmp = await getBitmap(page);
  return buildScan(bmp, {
    rotation: page.rotation || 0,
    quad: page.quad,
    filter: page.filter,
    maxSize: state.settings.maxSize,
    quality: state.settings.quality,
    watermark: state.settings.watermark,
    withThumb: false,
  });
}

/** 修改页面后：版本号 +1，缩略图重算 */
async function touchPage(page) {
  page._rev = (page._rev || 0) + 1;
  page._url = null;
  const bmp = await getBitmap(page);
  const { blob } = await buildScan(bmp, {
    rotation: page.rotation || 0,
    quad: page.quad,
    filter: page.filter,
    maxSize: 240,
    quality: 0.72,
    withThumb: false,
  });
  page.thumb = blob;
}

/* ================================================================== */
/* 路由                                                               */
/* ================================================================== */

function navigate(next, { replace = false } = {}) {
  const snapshot = {
    view: next.view ?? state.view,
    docId: next.doc?.id ?? state.doc?.id ?? null,
    index: next.index ?? state.index,
    query: next.query ?? state.query,
  };
  if (replace) history.replaceState(snapshot, '');
  else history.pushState(snapshot, '');
  Object.assign(state, next);
  render();
}

window.addEventListener('popstate', (e) => {
  const s = e.state;
  if (!s || s.view === 'home') {
    state.view = 'home';
    state.doc = null;
    render();
    return;
  }
  state.view = s.view === 'crop' || s.view === 'ocr' ? 'doc' : s.view;
  state.index = s.index ?? 0;
  if (s.docId && state.doc?.id !== s.docId) {
    loadDoc(s.docId).then((d) => {
      state.doc = d;
      render();
    });
  } else {
    render();
  }
});

function goHome() {
  navigate({ view: 'home', doc: null, query: state.query });
}

function render() {
  topbarEl.innerHTML = '';
  topbarEl.className = 'topbar';
  viewEl.className = 'view';
  viewEl.innerHTML = '';
  viewEl.scrollTop = 0;

  switch (state.view) {
    case 'doc':
      renderDoc();
      break;
    case 'settings':
      renderSettings();
      break;
    default:
      renderHome();
  }
}

/* ================================================================== */
/* 首页                                                               */
/* ================================================================== */

function renderHome() {
  topbarEl.classList.add('topbar--brand');
  // 首页这句"不上传"是承诺，必须与真实行为一致：本站开通了在线识别之后，
  // 用户点「在线识别」时那一页图片确实会离开设备，所以这里就改说"免登录"，
  // 把上传的边界交给识别页去写清楚——不能一边留着"不上传"一边能上传。
  topbarEl.innerHTML = `
    <div class="topbar__inner">
      <div class="topbar__title">全民扫描<span class="topbar__sub">${state.caps.serverAi ? '免费 · 无广告 · 免登录' : '免费 · 无广告 · 不上传'}</span></div>
      <button class="iconbtn" data-act="settings" title="设置">${icon('sliders')}</button>
    </div>`;

  const docs = filteredDocs();
  const body = docs.length
    ? `
      <div class="searchbar">
        ${icon('search', 18)}
        <input id="q" type="search" placeholder="搜索文档标题或文字内容" value="${escapeHtml(state.query)}" />
      </div>
      <div class="section-title">我的扫描件 <em>${docs.length} 份</em></div>
      <div class="doclist" id="doclist">${docs.map(docCardHtml).join('')}</div>`
    : emptyStateHtml();

  viewEl.innerHTML = `
    <div class="hero">
      <h2>把手机变成扫描仪</h2>
      <p>拍照自动去阴影、自动裁边，一键导出 PDF 和文字。<br/>${
        state.caps.serverAi
          ? '扫描、裁边、增强、导出都在你的手机上完成；只有你主动点「在线识别」时，那一页图片才会发去转成文字。'
          : '所有处理都在你的手机上完成，不上传任何一张图片。'
      }</p>
      <div class="hero__actions">
        <button class="btn btn--solid" data-act="shoot">${icon('camera', 20)} 拍照扫描</button>
        <button class="btn" data-act="import">${icon('image', 20)} 导入图片</button>
      </div>
    </div>
    ${body}
    <button class="fab" data-act="shoot">${icon('camera', 22)} 开始扫描</button>`;

  bindHome();
  renderDocsInto();
}

function filteredDocs() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.docs;
  return state.docs.filter((d) => (d.title || '').toLowerCase().includes(q));
}

function docCardHtml(d) {
  return `
    <div class="doccard" data-id="${d.id}">
      <div class="doccard__thumb">
        ${d.thumb ? `<img src="${blobUrl(d.thumb)}" alt="" loading="lazy" />` : `<span style="color:var(--text-3)">${icon('file', 34)}</span>`}
        <span class="doccard__badge">${d.pageCount} 页</span>
      </div>
      <div class="doccard__meta">
        <div class="doccard__title">${escapeHtml(d.title)}</div>
        <div class="doccard__date">${formatDate(d.updatedAt)}</div>
      </div>
    </div>`;
}

function emptyStateHtml() {
  return `
    <div class="empty">
      <div class="empty__ico">${icon('sparkle', 40)}</div>
      <h3>还没有扫描件</h3>
      <p>不用注册、不用登录、没有次数限制。点下面的按钮就能开始。</p>
      <div class="steps">
        <div class="step"><b>1</b><span>对着纸张拍一张，或从相册选图</span></div>
        <div class="step"><b>2</b><span>自动去阴影、自动裁边，可手动微调四角</span></div>
        <div class="step"><b>3</b><span>导出 PDF / 长图 / JPG / 文字，随手分享</span></div>
      </div>
    </div>`;
}

function bindHome() {
  $$('[data-act]').forEach((b) => {
    const act = b.dataset.act;
    if (act === 'settings') b.onclick = () => navigate({ view: 'settings' });
    if (act === 'shoot') b.onclick = () => startCapture('camera');
    if (act === 'import') b.onclick = () => pickFiles();
  });
  $$('.doccard').forEach((card) => {
    card.onclick = () => openDoc(card.dataset.id);
    card.oncontextmenu = (e) => {
      e.preventDefault();
      docActions(card.dataset.id);
    };
  });
  const q = $('#q');
  if (q) {
    q.oninput = () => {
      state.query = q.value;
      renderDocsInto();
    };
  }
}

/** 只重绘文档列表，输入搜索时不会丢焦点 */
function renderDocsInto() {
  const list = $('#doclist');
  if (!list) return;
  const docs = filteredDocs();
  list.innerHTML = docs.map(docCardHtml).join('');
  $$('.doccard', list).forEach((card) => {
    card.onclick = () => openDoc(card.dataset.id);
    card.oncontextmenu = (e) => {
      e.preventDefault();
      docActions(card.dataset.id);
    };
  });
}

async function refreshDocs() {
  state.docs = await listDocs();
}

async function docActions(id) {
  const d = state.docs.find((x) => x.id === id);
  if (!d) return;
  const act = await actionSheet({
    title: escapeHtml(d.title),
    items: [
      { label: '打开', value: 'open', icon: 'eye' },
      { label: '重命名', value: 'rename', icon: 'edit' },
      { label: '分享 / 导出', value: 'export', icon: 'share' },
      { label: '删除', value: 'delete', icon: 'trash', danger: true },
    ],
  });
  if (act === 'open') openDoc(id);
  else if (act === 'rename') {
    const name = await promptDialog({ title: '重命名', value: d.title });
    if (name) {
      await saveDoc({ ...(await loadDoc(id)), title: name });
      await refreshDocs();
      render();
    }
  } else if (act === 'export') {
    await openDoc(id);
    exportSheet();
  } else if (act === 'delete') {
    if (await confirmDialog({ title: '删除这份扫描件？', message: '删除后无法恢复，请先确认已经导出需要的文件。', okText: '删除', danger: true })) {
      await removeDoc(id);
      await refreshDocs();
      render();
      toast('已删除', 'success');
    }
  }
}

/* ================================================================== */
/* 采集：拍照 / 导入                                                   */
/* ================================================================== */

/** 确保当前有一份正在编辑的文档 */
function ensureDoc() {
  if (!state.doc) {
    const now = new Date();
    state.doc = {
      id: null,
      title: `扫描件 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`,
      createdAt: Date.now(),
      pages: [],
    };
  }
  return state.doc;
}

async function startCapture(mode) {
  if (mode === 'camera' && CameraView.supported) {
    const cam = new CameraView(cameraEl, {
      onCapture: (blob) => addImageBlob(blob, { silent: true }),
      onClose: async () => {
        if (state.doc?.pages?.length) {
          state.view = 'doc';
          state.index = Math.min(state.index, state.doc.pages.length - 1);
          await persistDoc();
          render();
        } else {
          render();
        }
      },
    });
    try {
      await cam.open();
      // 打开相机的过程中先建好文档，拍完立刻就能进编辑页
      ensureDoc();
    } catch (err) {
      cam.close?.();
      CameraView.showFallback(cameraEl, describeCameraError(err), () => pickFiles());
    }
  } else {
    pickFiles();
  }
}

function pickFiles() {
  fileInput.value = '';
  fileInput.click();
}

fileInput.addEventListener('change', async () => {
  if (!fileInput.files?.length) return;
  // 页面菜单点"插入页面/替换这一页"时会先把目标页记在 state 上，
  // 这里取走并清掉——不清的话下次从别处导入的图也会莫名其妙插到那一页去。
  const insertAfter = state._insertAfter ?? null;
  const replaceIndex = state._replaceIndex ?? null;
  state._insertAfter = null;
  state._replaceIndex = null;
  await addImageFiles(Array.from(fileInput.files), { insertAfter, replaceIndex });
});

/**
 * 把一张图片加入当前文档。
 * @param {Blob} blob
 * @param {{silent?: boolean, index?: number}} opts
 */
async function addImageBlob(blob, opts = {}) {
  const doc = ensureDoc();
  let bmp;
  try {
    bmp = await loadImage(blob);
  } catch {
    toast('这张图片没法读取（可能是 HEIC 等浏览器不支持的格式）', 'error');
    return null;
  }

  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;

  // 超大的原图先压一次，避免几十 MB 的图撑爆手机存储
  let source = blob;
  if (blob.size > 6 * 1024 * 1024 || Math.max(w, h) > 3600) {
    const scale = Math.min(1, 3600 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    source = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
  }

  // 自动找纸张四角（拍照场景基本都能找到，找不到就不裁）
  let quad = null;
  if (state.settings.autoCrop) {
    try {
      quad = autoDetectQuad(bmp);
    } catch {
      /* 检测失败不影响使用 */
    }
  }

  const page = {
    id: newId(),
    source,
    thumb: null,
    width: w,
    height: h,
    quad,
    rotation: 0,
    filter: state.settings.filter,
    text: '',
    _rev: 0,
  };

  await touchPage(page);
  if (opts.insertAt != null) doc.pages.splice(opts.insertAt, 0, page);
  else if (opts.index != null) doc.pages.splice(opts.index, 1, page);
  else doc.pages.push(page);

  await persistDoc();
  if (!opts.silent) {
    if (state.view === 'doc') {
      state.index = doc.pages.length - 1;
      render();
    } else {
      state.view = 'doc';
      state.index = doc.pages.length - 1;
      navigate({ view: 'doc', doc, index: state.index });
    }
    toast(`已加入第 ${state.index + 1} 页`, 'success');
  } else if (state.view === 'doc' && opts.index == null && opts.insertAt == null) {
    // 批量导入时才自动跳到最新一页；"插入/替换"有自己该停的位置，别抢
    state.index = doc.pages.length - 1;
    render();
  }
  return page;
}

/**
 * 批量导入（相册多选 / 拖拽 / 粘贴 / 页面菜单的插入与替换）。
 *
 * @param {File[]} files
 * @param {{insertAfter?: number|null, replaceIndex?: number|null}} [opts]
 *   insertAfter：把这些页插到该页之后（页面菜单的"插入页面"）
 *   replaceIndex：第一张替换掉该页，多出来的接在它后面（页面菜单的"替换这一页"）
 */
async function addImageFiles(files, opts = {}) {
  const imgs = files.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|bmp)$/i.test(f.name));
  if (!imgs.length) {
    toast('没有找到可用的图片文件', 'warn');
    return;
  }
  const { insertAfter = null, replaceIndex = null } = opts;
  showLoading(`正在处理 0/${imgs.length}`);
  let ok = 0;
  for (let i = 0; i < imgs.length; i++) {
    setProgress(i / imgs.length, `正在处理 ${i + 1}/${imgs.length}`);
    // 每张都要按"已经放进去了几张"往后挪，
    // 否则多选导入时后一张会把前一张刚占的坑覆盖掉（替换模式下尤其明显）。
    let place;
    if (replaceIndex != null) place = i === 0 ? { index: replaceIndex } : { insertAt: replaceIndex + i };
    else if (insertAfter != null) place = { insertAt: insertAfter + 1 + i };
    else place = {};
    try {
      await addImageBlob(imgs[i], { silent: true, ...place });
      ok++;
    } catch (err) {
      console.warn('导入失败', err);
    }
    await new Promise((r) => setTimeout(r, 0)); // 让界面有机会刷新
  }
  hideLoading();
  await persistDoc();
  state.view = 'doc';
  const pages = state.doc?.pages.length || 1;
  // 停在用户刚动过的那一页，而不是不管不顾跳到最后
  const focus = replaceIndex != null ? replaceIndex : insertAfter != null ? insertAfter + 1 : pages - 1;
  state.index = Math.max(0, Math.min(focus, pages - 1));
  navigate({ view: 'doc', doc: state.doc, index: state.index });
  if (!ok) return toast('导入失败', 'error');
  if (replaceIndex != null) toast(ok > 1 ? `已替换这一页，并插入 ${ok - 1} 页` : '已替换这一页', 'success');
  else if (insertAfter != null) toast(`已插入 ${ok} 页`, 'success');
  else toast(`已导入 ${ok} 页`, 'success');
}

/* ---------------------------- 拖拽 / 粘贴 ---------------------------- */

['dragover', 'drop'].forEach((t) =>
  window.addEventListener(t, (e) => e.preventDefault())
);
window.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length) addImageFiles(files);
});
window.addEventListener('paste', (e) => {
  const files = Array.from(e.clipboardData?.files || []);
  if (files.length) addImageFiles(files);
});

/* ================================================================== */
/* 文档编辑页                                                          */
/* ================================================================== */

function renderDoc() {
  if (!state.doc) {
    goHome();
    return;
  }
  const doc = state.doc;
  if (!doc.pages.length) {
    goHome();
    return;
  }
  state.index = Math.max(0, Math.min(state.index, doc.pages.length - 1));
  const page = doc.pages[state.index];

  topbarEl.innerHTML = `
    <div class="topbar__inner">
      <button class="iconbtn" data-act="back" title="返回">${icon('back')}</button>
      <div class="topbar__title" data-act="rename" style="cursor:pointer">${escapeHtml(doc.title)}
        <span class="topbar__sub">${doc.pages.length} 页 · ${filterLabel(page.filter)}</span>
      </div>
      <button class="iconbtn" data-act="share" title="导出 / 分享">${icon('share')}</button>
    </div>`;

  viewEl.classList.add('view--flush');
  viewEl.innerHTML = `
    <div class="editor">
      <div class="editor__stage" id="stage">
        <img id="page-img" alt="第 ${state.index + 1} 页预览" />
        <div class="editor__counter">${state.index + 1} / ${doc.pages.length}</div>
        <button class="editor__nav editor__nav--prev" data-act="prev" ${state.index === 0 ? 'disabled' : ''}>${icon('back', 20)}</button>
        <button class="editor__nav editor__nav--next" data-act="next" ${state.index === doc.pages.length - 1 ? 'disabled' : ''}>${icon('back', 20)}</button>
        <div class="filterbar" id="filterbar">
          <div class="filterbar__row" id="filterrow"></div>
          <div class="filterbar__hint" id="filterhint">点一下就能实时预览效果</div>
        </div>
      </div>
      <div class="editor__strip" id="strip">
        ${doc.pages
          .map(
            (p, i) => `
          <button class="pagethumb ${i === state.index ? 'is-active' : ''}" data-page="${i}">
            ${p.thumb ? `<img src="${blobUrl(p.thumb)}" alt="" />` : ''}
          </button>`
          )
          .join('')}
        <button class="pagethumb pagethumb--add" data-act="add" title="继续添加">${icon('plus', 20)}</button>
      </div>
      <div class="toolbar">
        <button class="tool" data-act="crop">${icon('crop', 22)}<span>裁边</span></button>
        <button class="tool" data-act="rotate">${icon('rotate', 22)}<span>旋转</span></button>
        <button class="tool" data-act="filter">${icon('filter', 22)}<span>滤镜</span></button>
        <button class="tool" data-act="ocr">${icon('text', 22)}<span>文字</span></button>
        <button class="tool tool--accent" data-act="more">${icon('more', 22)}<span>更多</span></button>
      </div>
    </div>`;

  bindDoc(page);
  showPage(page);
}

function filterLabel(id) {
  return (FILTERS.find((f) => f.id === id) || FILTERS[0]).name;
}

/** 异步把某一页的预览图渲染出来，渲染期间先显示缩略图，避免白屏 */
async function showPage(page) {
  const img = $('#page-img');
  if (!img) return;
  img.src = page.thumb ? blobUrl(page.thumb) : '';
  try {
    const blob = await renderPreview(page);
    if ($('#page-img') === img && state.doc?.pages[state.index] === page) {
      img.src = blobUrl(blob);
    }
  } catch (err) {
    console.error(err);
    toast('这一页渲染失败', 'error');
  }
}

function bindDoc(page) {
  $$('[data-act]', topbarEl).forEach((b) => {
    const act = b.dataset.act;
    if (act === 'back') b.onclick = () => leaveDoc();
    if (act === 'rename') b.onclick = renameDoc;
    if (act === 'share') b.onclick = exportSheet;
  });

  $$('[data-act]', viewEl).forEach((b) => {
    const act = b.dataset.act;
    const map = {
      prev: () => gotoPage(state.index - 1),
      next: () => gotoPage(state.index + 1),
      crop: openCropper,
      rotate: rotatePage,
      filter: toggleFilterBar,
      ocr: openOcr,
      more: moreSheet,
      add: () => startCapture('camera'),
    };
    if (map[act]) b.onclick = map[act];
  });

  $$('.pagethumb[data-page]').forEach((btn) => {
    btn.onclick = () => gotoPage(Number(btn.dataset.page));
  });

  // 手指左右滑动翻页
  const stage = $('#stage');
  let sx = 0;
  let sy = 0;
  let moved = false;
  stage.addEventListener(
    'touchstart',
    (e) => {
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      moved = false;
    },
    { passive: true }
  );
  stage.addEventListener(
    'touchend',
    (e) => {
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        moved = true;
        gotoPage(state.index + (dx < 0 ? 1 : -1));
      }
    },
    { passive: true }
  );

  document.onkeydown = (e) => {
    if (state.view !== 'doc') return;
    if (e.key === 'ArrowLeft') gotoPage(state.index - 1);
    if (e.key === 'ArrowRight') gotoPage(state.index + 1);
    if (e.key === 'Escape') leaveDoc();
  };
}

function gotoPage(i) {
  const doc = state.doc;
  if (!doc) return;
  const n = Math.max(0, Math.min(i, doc.pages.length - 1));
  if (n === state.index) return;
  state.index = n;
  history.replaceState({ view: 'doc', docId: doc.id, index: n }, '');
  // 只更新会变的部分，避免整页重绘导致闪烁
  const img = $('#page-img');
  const counter = $('.editor__counter');
  if (counter) counter.textContent = `${n + 1} / ${doc.pages.length}`;
  $$('.pagethumb[data-page]').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.page) === n));
  $$('.editor__nav--prev').forEach((b) => (b.disabled = n === 0));
  $$('.editor__nav--next').forEach((b) => (b.disabled = n === doc.pages.length - 1));
  if (img) img.alt = `第 ${n + 1} 页预览`;
  showPage(doc.pages[n]);
  const row = $('#filterrow');
  if (row && row.dataset.ready) markActiveFilter(doc.pages[n].filter);
}

async function leaveDoc() {
  await persistDoc();
  await refreshDocs();
  goHome();
}

async function persistDoc(silent = true) {
  if (!state.doc || !state.doc.pages.length) return;
  try {
    const meta = await saveDoc({ ...state.doc, pages: state.doc.pages });
    state.doc.id = meta.id;
    state.doc.updatedAt = meta.updatedAt;
    state.docs = state.docs.some((d) => d.id === meta.id)
      ? state.docs.map((d) => (d.id === meta.id ? meta : d))
      : [meta, ...state.docs];
  } catch (err) {
    console.error(err);
    if (!silent) toast('保存失败：' + err.message, 'error');
  }
}

async function openDoc(id) {
  const d = await loadDoc(id);
  if (!d) {
    toast('文档不存在', 'error');
    return;
  }
  state.doc = d;
  state.index = 0;
  navigate({ view: 'doc', doc: d, index: 0 });
}

async function renameDoc() {
  const name = await promptDialog({ title: '文档名称', value: state.doc.title, placeholder: '给这份扫描件起个名字' });
  if (name == null) return;
  state.doc.title = name || state.doc.title;
  await persistDoc();
  render();
}

async function rotatePage() {
  const page = state.doc.pages[state.index];
  page.rotation = ((page.rotation || 0) + 90) % 360;
  haptic();
  await touchPage(page);
  await persistDoc();
  // 缩略图变了，局部刷新
  const thumb = $(`.pagethumb[data-page="${state.index}"] img`);
  if (thumb) thumb.src = blobUrl(page.thumb);
  await showPage(page);
}

/* ------------------------------ 滤镜 ------------------------------ */

let filterPreviews = null;

async function toggleFilterBar() {
  const bar = $('#filterbar');
  if (!bar) return;
  if (bar.classList.contains('show')) {
    bar.classList.remove('show');
    filterPreviews = null;
    return;
  }
  bar.classList.add('show');
  const row = $('#filterrow');
  const page = state.doc.pages[state.index];
  if (!row.dataset.ready) {
    row.innerHTML = FILTERS.map(
      (f) => `<button class="filterchip ${f.id === page.filter ? 'is-active' : ''}" data-filter="${f.id}">
        <div class="filterchip__box">${page.thumb ? `<img src="${blobUrl(page.thumb)}" alt="" />` : ''}</div>${f.name}
      </button>`
    ).join('');
    $$('.filterchip', row).forEach((c) => {
      c.onclick = () => {
        const p = state.doc.pages[state.index];
        applyFilterTo(p, c.dataset.filter);
      };
    });
    row.dataset.ready = '1';

    // 异步生成真实滤镜缩略图，生成好后替换上去（比假装预览诚实得多）
    try {
      const bmp = await getBitmap(page);
      const rotated = rotateSource(bmp, page.rotation || 0);
      let src = rotated;
      if (page.quad) {
        const r = quadToRect(page.quad);
        if (!(r.w > 0.985 && r.h > 0.985 && r.x < 0.008 && r.y < 0.008)) {
          // warpPerspective 直接用静态导入的那个：这里原来写成 await import()，
          // 但 crop.js 在文件顶部已经静态导入过了，动态导入拿不到任何懒加载好处，
          // 只是白白多让出一帧（用户看到滤镜预览慢半拍）
          src = warpPerspective(rotated, page.quad, 420).canvas;
        }
      }
      filterPreviews = await buildFilterPreviews(src, { maxSize: 300 });
      $$('.filterchip', row).forEach((c) => {
        const b = filterPreviews[c.dataset.filter];
        const box = c.querySelector('.filterchip__box');
        if (b && box) box.innerHTML = `<img src="${blobUrl(b)}" alt="" />`;
      });
    } catch (err) {
      console.warn('滤镜预览生成失败', err);
    }
  }
  markActiveFilter(page.filter);
  const hint = $('#filterhint');
  const cur = FILTERS.find((f) => f.id === page.filter);
  if (hint && cur) hint.textContent = cur.hint;
}

function markActiveFilter(id) {
  $$('.filterchip').forEach((c) => c.classList.toggle('is-active', c.dataset.filter === id));
  const cur = FILTERS.find((f) => f.id === id);
  const hint = $('#filterhint');
  if (hint && cur) hint.textContent = cur.hint;
}

async function applyFilterTo(page, filterId) {
  page.filter = filterId;
  markActiveFilter(filterId);
  setSettings({ filter: filterId }); // 记住偏好，下一张照片默认用它
  state.settings.filter = filterId;
  showLoading('正在处理…');
  try {
    await touchPage(page);
    await persistDoc();
    const thumb = $(`.pagethumb[data-page="${state.index}"] img`);
    if (thumb) thumb.src = blobUrl(page.thumb);
    await showPage(page);
    const sub = $('.topbar__sub');
    if (sub) sub.textContent = `${state.doc.pages.length} 页 · ${filterLabel(filterId)}`;
  } finally {
    hideLoading();
  }
}

/* ------------------------------ 裁边 ------------------------------ */

async function openCropper() {
  const page = state.doc.pages[state.index];
  viewEl.classList.add('view--flush');
  viewEl.innerHTML = `
    <div class="cropper">
      <div class="cropper__stage">
        <canvas class="cropper__canvas" id="crop-canvas"></canvas>
        <div class="cropper__tips">拖动四个角对齐纸张边缘 · 双指缩放请用浏览器手势</div>
      </div>
      <div class="cropper__actions">
        <button class="btn btn--ghost" style="color:#fff;border-color:rgba(255,255,255,.25)" data-act="auto">${icon('sparkle', 18)} 自动</button>
        <button class="btn btn--ghost" style="color:#fff;border-color:rgba(255,255,255,.25)" data-act="full">全图</button>
        <button class="btn btn--primary" data-act="ok">完成</button>
      </div>
    </div>`;

  const canvas = $('#crop-canvas');
  const bmp = await getBitmap(page);
  const rotated = rotateSource(bmp, page.rotation || 0);
  const editor = new CropEditor(canvas, rotated, page.quad || rectToQuad({ x: 0.02, y: 0.02, w: 0.96, h: 0.96 }));
  requestAnimationFrame(() => editor.resize());
  const onResize = () => editor.resize();
  window.addEventListener('resize', onResize);

  const close = () => {
    window.removeEventListener('resize', onResize);
    editor.destroy();
  };

  $$('[data-act]', viewEl).forEach((b) => {
    const act = b.dataset.act;
    if (act === 'auto') {
      b.onclick = () => {
        const q = autoDetectQuad(rotated);
        if (q) {
          editor.setQuad(q);
          toast('已自动识别纸张边缘', 'success');
        } else {
          toast('没找到明显的纸张边缘，请手动拖动四角', 'warn');
        }
      };
    }
    if (act === 'full') b.onclick = () => editor.resetFull();
    if (act === 'ok') {
      b.onclick = async () => {
        page.quad = editor.getQuad();
        close();
        showLoading('正在应用裁剪…');
        try {
          await touchPage(page);
          await persistDoc();
          state.view = 'doc';
          render();
        } finally {
          hideLoading();
        }
      };
    }
  });
}

/* ------------------------------ 文字识别 ------------------------------ */

let ocrText = '';

async function openOcr() {
  const page = state.doc.pages[state.index];
  const saved = state.settings.ocrLang || 'chi_sim+eng';
  // 在线这条路有两个入口：本站服务端（免费、不用 Key）和用户自己的 Key。
  // 前者优先——用户什么都不用配就能用上，这才是"免费给人民用"。
  const target = onlineTarget(state.settings, state.caps);
  const online = target !== null;
  const viaServer = target === 'server';
  viewEl.classList.add('view--flush');
  topbarEl.innerHTML = `
    <div class="topbar__inner">
      <button class="iconbtn" data-act="back">${icon('back')}</button>
      <div class="topbar__title">文字识别</div>
      <button class="iconbtn" data-act="copy" title="复制全文">${icon('copy')}</button>
    </div>`;
  viewEl.innerHTML = `
    <div class="ocr">
      <div class="ocr__bar">
        <span>识别语言</span>
        <select id="ocr-lang" ${online ? 'disabled title="在线识别会自动判断语言"' : ''}>
          ${OCR_LANGS.map((l) => `<option value="${l.id}" ${l.id === saved ? 'selected' : ''}>${l.name}（${l.size}）</option>`).join('')}
        </select>
        <span class="spread"></span>
        <button class="btn btn--ghost" data-act="run" style="height:34px;padding:0 12px">${icon('sparkle', 16)} 开始识别</button>
      </div>
      <div class="ocr__body">
        <textarea class="ocr__text" id="ocr-text" placeholder="识别结果会出现在这里，可以直接编辑、复制或导出。">${escapeHtml(page.text || '')}</textarea>
        <div class="ocr__row ocr__row--engine">
          <label class="engine">
            <input type="radio" name="engine" value="online" ${online ? 'checked' : ''} ${online ? '' : 'disabled'} />
            <span>在线 AI（DeepSeek）${viaServer ? '<em class="engine__free">本站免费</em>' : ''}</span>
          </label>
          <label class="engine">
            <input type="radio" name="engine" value="local" ${online ? '' : 'checked'} />
            <span>本地离线</span>
          </label>
          <span class="spread"></span>
          <button class="btn btn--ghost" data-act="ai-settings" style="height:32px;padding:0 10px">${icon('sliders', 15)} 在线设置</button>
        </div>
        <div class="ocr__note">${
          viaServer
            ? `<b>当前：在线 AI 识别（本站已开通，不用自己填 Key）。</b>点「开始识别」后，这一页的图片会先传到本站服务器，再由服务器转给 DeepSeek 识别。<br/>
               服务器不保存图片、不记录识别内容，每个 IP 每小时 30 次、每天 200 次；不想上传就切回"本地离线"。`
            : online
              ? `<b>当前：在线 AI 识别（用你自己的 Key）。</b>这一页的图片会通过 HTTPS 上传到 DeepSeek 进行识别，并消耗你自己账号的额度（按 token 计费）。<br/>
                 图片只在这次请求里使用；不想上传就切回"本地离线"。`
              : `当前：本地离线识别。第一次使用会下载语言模型（一次性，之后浏览器会缓存）。<br/>
                 <b>图片和识别过程都在你的设备上完成，不会上传到任何服务器。</b>
                 ${hasKey(state.settings) ? '' : '<br/>想在手机上手写/复杂版式认得更准？填一个自己的 DeepSeek Key 就能用在线识别。'}`
        }</div>
        <div class="ocr__row">
          <button class="btn btn--ghost" data-act="clear">清空</button>
          <button class="btn btn--ghost" data-act="txt">导出…</button>
          <button class="btn btn--primary" data-act="save" disabled>已保存</button>
        </div>
      </div>
    </div>`;

  const textEl = $('#ocr-text');
  const langEl = $('#ocr-lang');
  textEl.addEventListener('input', () => markDirty(textEl.value.trim() !== (page.text || '')));

  // "保存"这个按钮的意义：文本框里改了字（识别错的名字、多认出来的乱码），
  // 想立刻把改动存进这一页。识别完、离开页面时都会自动存，所以按钮平时是灰的
  // ——灰着才说明"没有未保存的改动"，而不是摆一个按了也不知道发生了什么的按钮。
  const saveBtn = $('[data-act="save"]', viewEl);
  const markDirty = (dirty) => {
    if (!saveBtn) return;
    saveBtn.disabled = !dirty;
    saveBtn.textContent = dirty ? '保存修改' : '已保存';
  };
  const markClean = () => markDirty(false);

  const save = async (quiet) => {
    const next = textEl.value.trim();
    if (next === (page.text || '')) {
      if (!quiet) toast('没有改动', 'info');
      return;
    }
    // 用户动过字就不再套用识别时的版式了：那份 Markdown 是改动前的内容，
    // 拿它导出 Word 会把用户刚改的字丢掉——宁可降级成纯文字排版。
    const hadLayout = Boolean(page.md);
    page.text = next;
    page.md = '';
    await persistDoc();
    markClean();
    if (!quiet) toast(hadLayout ? '已存进这一页（改过字后，导出按纯文字排版）' : '已把文字存进这一页', 'success', 3600);
  };

  $$('[data-act]', topbarEl).forEach((b) => {
    if (b.dataset.act === 'back') b.onclick = () => leaveOcr(save);
    if (b.dataset.act === 'copy')
      b.onclick = async () => {
        if (!textEl.value.trim()) return toast('还没有可复制的内容', 'warn');
        // 只复制一次：写两遍既浪费，也可能出现"第一次成功、第二次失败"时
        // 提示与实际结果对不上的情况
        const ok = await copyText(textEl.value);
        toast(ok ? '已复制全文' : '复制失败，请手动选择', ok ? 'success' : 'error');
      };
  });

  $$('[data-act]', viewEl).forEach((b) => {
    const act = b.dataset.act;
    if (act === 'run') b.onclick = () => runOcr(page, textEl, langEl.value, b, markClean);
    if (act === 'clear')
      b.onclick = () => {
        textEl.value = '';
        markDirty(Boolean((page.text || '').trim()));
      };
    // 导出前先把文本框里的改动落盘，否则"看见的字"和"导出的字"会对不上
    if (act === 'txt') b.onclick = async () => {
      await save(true);
      exportTextSheet();
    };
    if (act === 'save') b.onclick = save;
    if (act === 'ai-settings') b.onclick = () => navigate({ view: 'settings' });
  });

  // 切换引擎：只改这一次的偏好，立刻重画这一页的说明文字（说明必须与真实行为一致）
  $$('input[name="engine"]', viewEl).forEach((el) => {
    el.onchange = () => {
      state.settings = setSettings({ ocrEngine: el.value });
      openOcr();
      toast(
        el.value === 'online'
          ? viaServer
            ? '这次用在线 AI 识别（本站免费），图片会上传'
            : '这次用在线 AI 识别，图片会上传'
          : '这次用本地离线识别',
        'info',
        3000,
      );
    };
  });

  langEl.onchange = () => {
    state.settings = setSettings({ ocrLang: langEl.value });
    toast('已切换识别语言，点"开始识别"生效');
  };

  // 已有结果就不重复识别，省流量省时间
  if (page.text) return;
  // 在线识别绝不自动开跑：不管是花用户的额度还是花站里的额度，进页面就偷偷
  // 把图片传出去都不行，必须由用户点一下"开始识别"才发生。
  // 本地识别没有这个顾虑，照旧自动跑。
  if (online) {
    const runBtn = $('[data-act="run"]');
    runBtn?.classList.add('btn--pulse');
    toast(viaServer ? '点一下"开始识别"再上传（本站免费）' : '这页要用在线 AI 识别，点一下"开始识别"再上传', 'info', 4200);
    return;
  }
  runOcr(page, textEl, langEl.value, $('[data-act="run"]'));
}

async function leaveOcr(save) {
  await save();
  state.view = 'doc';
  render();
}

async function runOcr(page, textEl, lang, btn, onSaved) {
  if (btn) btn.disabled = true;
  showLoading('正在准备识别…', 0.02);
  // 用哪个引擎：本站服务端（免费、不用 Key）> 用户自己的 Key > 本地 Tesseract
  const target = onlineTarget(state.settings, state.caps);
  try {
    // 用增强后的图去识别，准确率明显高于原图
    const bmp = await getBitmap(page);
    const { canvas } = await buildScan(bmp, {
      rotation: page.rotation || 0,
      quad: page.quad,
      filter: page.filter === 'original' ? 'grayClean' : page.filter,
      maxSize: 2200,
      quality: 0.92,
      withThumb: false,
    });

    let text;
    let note;
    let md = '';
    if (target === 'server') {
      setProgress(0.15, '正在上传到本站服务器');
      const r = await recognizeViaServer(canvas, { onProgress: (p, s) => setProgress(p, s) });
      md = r.text;
      note = `已用在线 AI 识别（${r.model}）`;
    } else if (target === 'byok') {
      setProgress(0.15, '正在上传到 DeepSeek');
      const r = await recognizeOnline(canvas, {
        apiKey: state.settings.aiKey,
        model: state.settings.aiModel || DEFAULT_MODEL,
        prompt: LAYOUT_PROMPT,
        onProgress: (p, s) => setProgress(p, s),
      });
      md = r.text;
      note = `已用在线 AI 识别（${r.model}）`;
    } else {
      const r = await recognize(canvas, { lang, onProgress: (p, s) => setProgress(p, s) });
      text = r.text;
      note = `已用本地识别，置信度 ${Math.round(r.confidence)}%`;
    }

    // 在线识别拿到的是 Markdown：既留一份原文（导出 Word / 排版 PDF 时用），
    // 也拆成纯文字（文本框里给用户看的、导出 TXT 用的都是它）。
    // 认出来是手写、收据这种没有版式的东西时，Markdown 只是多余的壳，丢掉。
    if (md) {
      if (looksStructured(md)) text = blocksToPlain(parseMarkdown(md));
      else {
        text = md;
        md = '';
      }
    }

    hideLoading();
    if (!text) {
      toast('没有识别到文字，试试换一个更清晰的拍摄角度', 'warn');
      return;
    }
    textEl.value = text;
    // 识别出来就立刻存进这一页。用户点的是"开始识别"，不是"识别完还要记得按保存"——
    // 手机上一转身切个 App，结果就没了，那才是真的气人。
    page.text = text.trim();
    page.md = md.trim(); // 空字符串 = 没有版式信息
    await persistDoc();
    onSaved?.();
    toast(`${note}，已存进这一页`, 'success');
  } catch (err) {
    hideLoading();
    let msg = err?.message || '识别失败';
    // 在线失败时补一句退路：用户手上就有能用的本地方案，不该让他卡在这里
    if (target && !/本地/.test(msg)) msg += '；也可以切到「本地离线」再试';
    toast(msg, 'error', 6000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ------------------------------ 更多操作 ------------------------------ */

async function moreSheet() {
  const page = state.doc.pages[state.index];
  const act = await actionSheet({
    title: `第 ${state.index + 1} 页`,
    items: [
      { label: '导出 / 分享', value: 'export', icon: 'share', desc: 'PDF、长图、JPG、文字' },
      { label: '插入图片（在本页之后）', value: 'insert', icon: 'plus' },
      { label: '把这一页替换掉', value: 'replace', icon: 'swap' },
      { label: '设水印', value: 'watermark', icon: 'shield', desc: state.settings.watermark ? `当前：${state.settings.watermark}` : '默认无水印' },
      { label: '复制这一页', value: 'duplicate', icon: 'copy' },
      { label: '向左转 90°', value: 'rotateL', icon: 'rotate' },
      { label: '删除这一页', value: 'delete', icon: 'trash', danger: true },
      { label: '删除整份文档', value: 'deleteDoc', icon: 'trash', danger: true },
    ],
  });
  if (!act) return;

  if (act === 'export') return exportSheet();
  if (act === 'insert') {
    state._insertAfter = state.index;
    return pickFiles();
  }
  if (act === 'replace') {
    state._replaceIndex = state.index;
    return pickFiles();
  }
  if (act === 'duplicate') {
    const copy = { ...page, id: newId(), _rev: 0 };
    state.doc.pages.splice(state.index + 1, 0, copy);
    await persistDoc();
    state.index += 1;
    render();
    return toast('已复制这一页', 'success');
  }
  if (act === 'rotateL') {
    page.rotation = ((page.rotation || 0) + 270) % 360;
    await touchPage(page);
    await persistDoc();
    render();
    return;
  }
  if (act === 'watermark') {
    const w = await promptDialog({
      title: '水印文字',
      value: state.settings.watermark,
      placeholder: '例如：仅供办理业务使用 / 内部资料',
    });
    if (w == null) return;
    state.settings = setSettings({ watermark: w });
    toast(w ? '水印已开启，导出时生效' : '已关闭水印', 'success');
    return;
  }
  if (act === 'delete') {
    if (state.doc.pages.length === 1) {
      toast('至少要保留一页，可以直接删除整份文档', 'warn');
      return;
    }
    state.doc.pages.splice(state.index, 1);
    state.index = Math.max(0, state.index - 1);
    await persistDoc();
    render();
    return toast('已删除这一页', 'success');
  }
  if (act === 'deleteDoc') {
    if (await confirmDialog({ title: '删除整份文档？', message: '所有页面都会从本机删除，无法恢复。', okText: '删除', danger: true })) {
      if (state.doc.id) await removeDoc(state.doc.id);
      await refreshDocs();
      state.doc = null;
      goHome();
      toast('已删除', 'success');
    }
  }
}

/* ================================================================== */
/* 导出与分享                                                          */
/* ================================================================== */

async function exportSheet() {
  if (!state.doc?.pages.length) return;
  const n = state.doc.pages.length;
  const act = await actionSheet({
    title: `导出 ${n} 页`,
    items: [
      { label: '导出为 PDF', value: 'pdf', icon: 'file', desc: '照片版，所见即所得，可打印、可发给别人' },
      { label: '导出为长图', value: 'long', icon: 'image', desc: '一张竖长图，方便发微信' },
      { label: '导出 JPG 压缩包', value: 'zip', icon: 'zip', desc: `${n} 张原图，打包成 zip` },
      { label: '导出文字 / Word', value: 'textmenu', icon: 'text', desc: 'Word、排版 PDF、纯文字 PDF、TXT' },
      { label: '分享…', value: 'share', icon: 'share', desc: '用系统面板发给别人' },
    ],
  });
  if (!act) return;
  if (act === 'pdf') return exportPdf();
  if (act === 'long') return exportLongImage();
  if (act === 'zip') return exportZip();
  if (act === 'textmenu') return exportTextSheet();
  if (act === 'share') return sharePdf();
}

async function renderAllPages(onProgress) {
  const pages = state.doc.pages;
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(i / pages.length, `正在处理第 ${i + 1}/${pages.length} 页`);
    out.push(await renderFull(pages[i]));
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

async function exportPdf() {
  showLoading('正在生成 PDF…', 0);
  try {
    const rendered = await renderAllPages((p, t) => setProgress(p * 0.8, t));
    setProgress(0.85, '正在打包 PDF');
    const pages = [];
    for (const r of rendered) {
      const buf = await r.blob.arrayBuffer();
      pages.push({ jpeg: new Uint8Array(buf), width: r.width, height: r.height });
    }
    const bytes = buildPDF(pages, {
      pageSize: state.settings.pageSize,
      title: state.doc.title,
      margin: 16,
    });
    setProgress(1, '完成');
    const name = `${safeName(state.doc.title)}.pdf`;
    download(new Blob([bytes], { type: 'application/pdf' }), name);
    await persistDoc();
    hideLoading();
    toast(`已导出 ${name}（${formatBytes(bytes.length)}）`, 'success', 3600);
  } catch (err) {
    hideLoading();
    console.error(err);
    toast('导出失败：' + (err.message || '未知错误'), 'error');
  }
}

async function exportLongImage() {
  showLoading('正在拼接长图…', 0);
  try {
    const rendered = await renderAllPages((p, t) => setProgress(p * 0.85, t));
    setProgress(0.9, '正在拼接');
    const blob = await mergeToLongImage(
      rendered.map((r) => r.canvas),
      { watermark: state.settings.watermark, quality: state.settings.quality }
    );
    const name = `${safeName(state.doc.title)}_长图.jpg`;
    download(blob, name);
    hideLoading();
    toast(`已导出长图（${formatBytes(blob.size)}）`, 'success', 3600);
  } catch (err) {
    hideLoading();
    toast('导出失败：' + (err.message || '未知错误'), 'error');
  }
}

async function exportZip() {
  showLoading('正在打包 JPG…', 0);
  try {
    const rendered = await renderAllPages((p, t) => setProgress(p * 0.85, t));
    setProgress(0.9, '正在压缩');
    const base = safeName(state.doc.title);
    const files = rendered.map((r, i) => ({
      name: `${base}_${String(i + 1).padStart(2, '0')}.jpg`,
      data: r.blob,
    }));
    const bytes = await buildZip(files);
    download(new Blob([bytes], { type: 'application/zip' }), `${base}.zip`);
    hideLoading();
    toast(`已打包 ${files.length} 张图片`, 'success');
  } catch (err) {
    hideLoading();
    toast('打包失败：' + (err.message || '未知错误'), 'error');
  }
}

/**
 * 取出文档里所有识别过的文字。
 * 第三份导出（TXT / 文字版 PDF）都要用它，所以顺手把"哪几页还没识别"也算出来，
 * 好让提示说清楚——用户看到"已导出"却发现少了两页，那是最糟的体验。
 */
/**
 * 有版式信息的页（= 在线识别过的页）。
 * 本地识别只有一行行文字，没有标题/表格结构，不能假装有。
 */
function layoutParts() {
  return state.doc.pages
    .map((p, i) => ({ index: i + 1, md: (p.md || '').trim() }))
    .filter((p) => p.md);
}

async function exportTextSheet() {
  const pages = state.doc.pages;
  const textPages = pages.filter((p) => (p.text || '').trim()).length;
  const mdPages = layoutParts().length;
  const act = await actionSheet({
    title: '导出文字',
    items: [
      {
        label: 'Word 文档（.docx）',
        value: 'word',
        icon: 'text',
        desc: mdPages ? `标题、表格、加粗都保留，拿到手能接着改（${mdPages} 页）` : '要先用在线识别，本地识别没有版式',
      },
      {
        label: '排版 PDF',
        value: 'layoutpdf',
        icon: 'file',
        desc: mdPages ? '按原文档的标题和表格排，字能选中、能搜索' : '要先用在线识别，本地识别没有版式',
      },
      { label: '纯文字 PDF', value: 'textpdf', icon: 'file', desc: textPages ? '只要字，体积最小，适合归档' : '需要先识别一次' },
      { label: 'TXT 纯文本', value: 'txt', icon: 'text', desc: textPages ? '给别的软件接着用' : '需要先识别一次' },
    ],
  });
  if (!act) return;
  if (act === 'word') return exportWord();
  if (act === 'layoutpdf') return exportLayoutPdf();
  if (act === 'textpdf') return exportTextPdf();
  if (act === 'txt') return exportText();
}

/** 把有版式的页拼成一份 Markdown（\f 分页，和其他导出保持一页对一页） */
function layoutMarkdown() {
  return layoutParts()
    .map((p) => p.md)
    .join('\n\f\n');
}

/** Word：给"还要继续改这份文档"的人 */
async function exportWord() {
  const parts = layoutParts();
  if (!parts.length) {
    toast('还没有可排版的文字：在线识别一次才有版式（本地识别只有纯文字）', 'warn', 4000);
    return;
  }
  showLoading('正在生成 Word…', 0.2);
  try {
    const bytes = await buildDOCX(parseMarkdown(layoutMarkdown()), { title: state.doc.title });
    hideLoading();
    const name = `${safeName(state.doc.title)}.docx`;
    download(
      new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      name
    );
    const missing = state.doc.pages.length - parts.length;
    toast(
      missing > 0 ? `已导出 Word（${formatBytes(bytes.length)}，有 ${missing} 页没版式，没放进去）` : `已导出 Word（${formatBytes(bytes.length)}）`,
      'success',
      4000
    );
  } catch (err) {
    hideLoading();
    console.error(err);
    toast('导出 Word 失败：' + (err.message || '未知错误'), 'error', 5000);
  }
}

/** 排版 PDF：给"要打印/要发给别人看"的人 */
function exportLayoutPdf() {
  const parts = layoutParts();
  if (!parts.length) {
    toast('还没有可排版的文字：在线识别一次才有版式（本地识别只有纯文字）', 'warn', 4000);
    return;
  }
  try {
    const bytes = buildMarkdownPDF(parseMarkdown(layoutMarkdown()), { title: state.doc.title, margin: 64 });
    download(new Blob([bytes], { type: 'application/pdf' }), `${safeName(state.doc.title)}_排版.pdf`);
    const missing = state.doc.pages.length - parts.length;
    toast(
      missing > 0
        ? `已导出排版 PDF（有 ${missing} 页没版式，没放进去）`
        : `已导出排版 PDF（${formatBytes(bytes.length)}）`,
      'success',
      4000
    );
  } catch (err) {
    console.error(err);
    toast('导出排版 PDF 失败：' + (err.message || '未知错误'), 'error', 5000);
  }
}

function collectText() {
  const pages = state.doc.pages;
  const parts = [];
  const missing = [];
  pages.forEach((p, i) => {
    const t = p.text?.trim();
    if (t) parts.push({ index: i + 1, text: t });
    else missing.push(i + 1);
  });
  return { pages, parts, missing };
}

function exportText() {
  const { pages, parts, missing } = collectText();
  if (!parts.length) {
    toast('还没有识别过文字，先点"文字"识别一下', 'warn', 3200);
    return;
  }
  const header = `${state.doc.title}\n导出时间：${new Date().toLocaleString('zh-CN')}\n共 ${pages.length} 页，其中 ${parts.length} 页有文字\n\n`;
  const body = parts.map((p) => `—— 第 ${p.index} 页 ——\n${p.text}`).join('\n\n');
  download(header + body, `${safeName(state.doc.title)}.txt`, 'text/plain;charset=utf-8');
  toast(missing.length ? `已导出文字（第 ${missing.join('、')} 页还没识别）` : '已导出文字', 'success', 3200);
}

/** 文字版 PDF：光有字，没有照片。能选中、能搜索、几 KB，适合归档和二次编辑 */
function exportTextPdf() {
  const { parts, missing } = collectText();
  if (!parts.length) {
    toast('还没有识别过文字，先点"文字"识别一下', 'warn', 3200);
    return;
  }
  try {
    // 每页扫描件对应 PDF 里的一页（\f 是强制翻页），这样和原件对得上
    const text = parts.map((p) => p.text).join('\n\f\n');
    const bytes = buildTextPDF(text, { title: state.doc.title, margin: 64 });
    const name = `${safeName(state.doc.title)}_文字版.pdf`;
    download(new Blob([bytes], { type: 'application/pdf' }), name);
    toast(
      missing.length
        ? `已导出文字版 PDF（第 ${missing.join('、')} 页还没识别，没放进去）`
        : `已导出文字版 PDF（${formatBytes(bytes.length)}）`,
      'success',
      3600
    );
  } catch (err) {
    console.error(err);
    toast('导出失败：' + (err.message || '未知错误'), 'error');
  }
}

async function buildPdfBlob() {
  const rendered = await renderAllPages((p, t) => setProgress(p * 0.8, t));
  const pages = [];
  for (const r of rendered) {
    pages.push({ jpeg: new Uint8Array(await r.blob.arrayBuffer()), width: r.width, height: r.height });
  }
  return new Blob([buildPDF(pages, { pageSize: state.settings.pageSize, title: state.doc.title, margin: 16 })], {
    type: 'application/pdf',
  });
}

async function sharePdf() {
  showLoading('正在准备分享…', 0);
  try {
    const blob = await buildPdfBlob();
    const name = `${safeName(state.doc.title)}.pdf`;
    const file = new File([blob], name, { type: 'application/pdf' });
    hideLoading();
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: state.doc.title });
    } else if (navigator.share) {
      download(blob, name);
      toast('当前浏览器不支持直接分享文件，已改为下载', 'warn', 3200);
    } else {
      download(blob, name);
      toast('已下载 PDF（浏览器不支持分享面板）', 'success');
    }
  } catch (err) {
    hideLoading();
    if (err?.name !== 'AbortError') toast('分享失败：' + (err.message || ''), 'error');
  }
}

/* ================================================================== */
/* 设置                                                               */
/* ================================================================== */

async function renderSettings() {
  state.settings = getSettings();
  const u = await usage();
  topbarEl.innerHTML = `
    <div class="topbar__inner">
      <button class="iconbtn" data-act="back">${icon('back')}</button>
      <div class="topbar__title">设置</div>
    </div>`;

  const setRow = (id, label, desc, options, value) => `
    <div class="row">
      <div class="row__label">${label}${desc ? `<em>${desc}</em>` : ''}</div>
      <select data-set="${id}">
        ${options.map((o) => `<option value="${o.value}" ${String(o.value) === String(value) ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
    </div>`;

  viewEl.innerHTML = `
    <div class="settings">
      <div class="group">
        <div class="group__title">扫描效果</div>
        ${setRow('filter', '默认滤镜', '拍完自动套用的效果', FILTERS.map((f) => ({ value: f.id, label: f.name })), state.settings.filter)}
        ${setRow(
          'maxSize',
          '输出清晰度',
          '长边像素，越大越清楚、文件也越大',
          [
            { value: 1600, label: '省空间（1600）' },
            { value: 2000, label: '标准（2000）' },
            { value: 2400, label: '清晰（2400）' },
            { value: 3000, label: '高清（3000）' },
          ],
          state.settings.maxSize
        )}
        ${setRow(
          'quality',
          '图片质量',
          'JPG 压缩质量，90% 左右最平衡',
          [
            { value: 0.75, label: '较小（75%）' },
            { value: 0.85, label: '标准（85%）' },
            { value: 0.9, label: '高清（90%）' },
            { value: 0.95, label: '极高（95%）' },
          ],
          state.settings.quality
        )}
        <div class="row">
          <div class="row__label">自动裁边<em>拍照后自动识别纸张边缘</em></div>
          <input type="checkbox" data-set="autoCrop" ${state.settings.autoCrop ? 'checked' : ''} style="width:22px;height:22px" />
        </div>
        <div class="row">
          <div class="row__label">水印文字<em>留空表示不加水印，导出时生效</em></div>
          <input type="text" data-set="watermark" value="${escapeHtml(state.settings.watermark)}" placeholder="不加" />
        </div>
      </div>

      <div class="group">
        <div class="group__title">导出</div>
        ${setRow(
          'pageSize',
          'PDF 纸张',
          'A4 适合打印，自适应适合手机阅读',
          [
            { value: 'a4', label: 'A4 纸' },
            { value: 'auto', label: '自适应图片' },
          ],
          state.settings.pageSize
        )}
        ${setRow('ocrLang', '识别语言', '中文文档选"中文+英文"最稳', OCR_LANGS.map((l) => ({ value: l.id, label: l.name })), state.settings.ocrLang)}
      </div>

      <div class="group">
        <div class="group__title">在线 AI 识别${state.caps.serverAi ? '' : '（可选）'}</div>
        ${
          state.caps.serverAi
            ? `<div class="row"><div class="row__label"><b>本站已开通在线识别，不用填 Key。</b><em>识别时那一页图片会经本站服务器转给 ${escapeHtml(state.caps.model || 'DeepSeek')}；
               ${state.caps.limits ? `每 IP 每小时 ${state.caps.limits.perHour} 次、每天 ${state.caps.limits.perDay} 次` : '有频次限制'}。
               下面这些是给"想用自己的 Key 直连"的人准备的，不填也完全能用。</em></div></div>`
            : ''
        }
        ${setRow(
          'ocrEngine',
          '识别引擎',
          state.caps.serverAi ? '自动 = 优先用本站免费的在线识别，需要时自动退回本地离线' : '自动 = 填了 Key 就用在线，没填就一直用本地离线',
          [
            { value: 'auto', label: '自动（推荐）' },
            { value: 'local', label: '只用本地离线' },
            { value: 'online', label: '只用在线 AI' },
          ],
          state.settings.ocrEngine
        )}
        <div class="row">
          <div class="row__label">DeepSeek API Key<em>只存在这台设备上，不会发给任何人</em></div>
          <input type="password" data-set="aiKey" value="${escapeHtml(state.settings.aiKey)}" placeholder="sk-…" autocomplete="off" spellcheck="false" />
        </div>
        ${setRow('aiModel', '模型', '推荐 deepseek-flash，它支持看图', AI_MODELS.map((m) => ({ value: m.id, label: m.name })), state.settings.aiModel)}
        <div class="row row--tap" data-act="test-key"><div class="row__label">测试 Key 能不能用<em>只发一句话，不传图片，几乎不花额度</em></div><span class="row__value">›</span></div>
        <div class="row">
          <div class="row__label">开通地址<em>platform.deepseek.com 注册后在"API keys"里创建，需自行充值</em></div>
          <div class="row__value"><a href="https://platform.deepseek.com/" target="_blank" rel="noreferrer noopener">打开</a></div>
        </div>
      </div>

      <div class="group">
        <div class="group__title">存储</div>
        <div class="row">
          <div class="row__label">已用空间<em>${u ? `浏览器可用约 ${formatBytes(Math.max(0, u.quota - u.used))}` : '当前浏览器不提供容量信息'}</em></div>
          <div class="row__value">${u ? formatBytes(u.used) : '—'}</div>
        </div>
        <div class="row row--tap" data-act="clear"><div class="row__label row__danger">清空所有扫描件</div></div>
      </div>

      <div class="group">
        <div class="group__title">关于</div>
        <div class="row">
          <div class="row__label">全民扫描 ScanFree<em>版本 1.0 · 免费 · 无广告 · 无登录</em></div>
        </div>
        <div class="row">
          <div class="row__label">数据存在哪里<em>只存在你这台设备的浏览器里。清除浏览器数据会一并清除，重要文件请及时导出备份。</em></div>
        </div>
        <div class="row row--tap" data-act="privacy"><div class="row__label">隐私说明</div><span class="row__value">›</span></div>
      </div>

      <div class="about">
        <b>它不收集你的任何信息。</b><br/>
        没有账号、没有服务器、没有埋点统计。<br/>
        断网也能正常拍照、裁边、导出 PDF。<br/>
        需要联网的只有两处，都是为了"识别文字"：下载本地识别模型，<br/>
        以及你主动填了 Key 之后调用的在线 AI 识别（那一页图片会上传）。
      </div>
    </div>`;

  $$('[data-act]', topbarEl).forEach((b) => (b.onclick = goHome));
  $$('[data-set]').forEach((el) => {
    el.onchange = () => {
      const key = el.dataset.set;
      let val = el.type === 'checkbox' ? el.checked : el.value;
      if (key === 'maxSize' || key === 'quality') val = Number(val);
      state.settings = setSettings({ [key]: val });
      toast('已保存', 'success', 1200);
    };
  });
  $$('[data-act="clear"]').forEach((el) => {
    el.onclick = async () => {
      if (await confirmDialog({ title: '清空所有扫描件？', message: '本机保存的全部文档都会被删除，无法恢复。', okText: '全部删除', danger: true })) {
        await clearAll();
        await ocrTerminate();
        await refreshDocs();
        state.doc = null;
        goHome();
        toast('已清空', 'success');
      }
    };
  });
  $$('[data-act="privacy"]').forEach((el) => {
    el.onclick = () =>
      actionSheet({
        title: '隐私说明',
        items: [
          {
            label: '默认不联网上传',
            value: 'a',
            icon: 'shield',
            desc: hasKey(state.settings)
              ? '你填了 Key，文字识别时会把你点"开始识别"的那一页图片传给 DeepSeek'
              : '拍照、裁边、增强、导出全部在本地完成，没有任何上传接口',
          },
          { label: '不收集信息', value: 'b', icon: 'eye', desc: '没有账号体系、没有统计代码、没有广告 SDK' },
          { label: 'Key 存在本机', value: 'e', icon: 'sliders', desc: 'API Key 只写进本机 localStorage，只用于直连 DeepSeek' },
          { label: '数据可带走', value: 'c', icon: 'download', desc: '随时导出 PDF / 图片 / 文字' },
          { label: '数据可清除', value: 'd', icon: 'trash', desc: '设置里一键清空，不留痕迹' },
        ],
      });
  });
  $$('[data-act="test-key"]').forEach((el) => {
    el.onclick = async () => {
      if (!hasKey(state.settings)) return toast('先填一个 API Key', 'warn');
      showLoading('正在测试…', 0.3);
      try {
        await testKey(state.settings.aiKey, { model: state.settings.aiModel || DEFAULT_MODEL });
        hideLoading();
        toast('Key 可用，在线识别已经能用了', 'success');
      } catch (err) {
        hideLoading();
        toast(err?.message || '测试失败', 'error', 6000);
      }
    };
  });
}

/* ================================================================== */
/* 启动                                                               */
/* ================================================================== */

async function boot() {
  // 支持 PWA 快捷方式：?action=camera 直接打开相机
  const params = new URLSearchParams(location.search);
  history.replaceState({ view: 'home' }, '');

  await refreshDocs();
  render();

  // 先渲染再探服务端：探测慢（或超时 4s）也不能让用户对着白屏等。
  // 探到了就重画一次首页，把"本站免费在线识别"这类文案换成真的。
  probeServer()
    .then((caps) => {
      if (!caps) return;
      state.caps = caps;
      if (state.view === 'home') render();
    })
    .catch(() => {});

  window.addEventListener('beforeunload', () => {
    // 尽力保存（同步接口不可用，只能靠平时已经存过）
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      persistDoc();
      ocrTerminate();
    }
  });

  if (params.get('action') === 'camera') {
    setTimeout(() => startCapture('camera'), 350);
  }

  // 首次使用给一句人话提示
  if (!localStorage.getItem('scanfree.seen')) {
    localStorage.setItem('scanfree.seen', '1');
    setTimeout(() => toast('点"开始扫描"就能用了，不需要注册', 'info', 3600), 700);
  }
}

boot();
