/**
 * store.js —— 本地存储层（IndexedDB）。
 *
 * 设计原则：文档只存在用户自己的设备上，不上传、不登录、不联网。
 *  - docs 表：文档元信息 + 小缩略图（列表页只读这张表，快）
 *  - pages 表：每页的原始 JPEG、缩略图、识别文字（按 docId 建索引）
 *
 * 所有 Blob 直接存二进制，避免 base64 膨胀 33% 体积。
 */

const DB_NAME = 'scanfree';
const DB_VERSION = 1;
const STORE_DOCS = 'docs';
const STORE_PAGES = 'pages';

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DOCS)) {
        db.createObjectStore(STORE_DOCS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PAGES)) {
        const s = db.createObjectStore(STORE_PAGES, { keyPath: 'id' });
        s.createIndex('byDoc', 'docId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, stores, mode = 'readonly') {
  return db.transaction(stores, mode);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * 保存（新建或覆盖）一份文档。
 * 注意：这里保存的是**原始照片**（source）+ 编辑参数（quad/rotation/filter），
 * 而不是处理后的成品图。这样改裁剪、换滤镜永远不会损失画质，存储也只占一份。
 *
 * @param {{id?: string, title: string, createdAt?: number, pages: Array}} doc
 *        pages 元素：{id?, source: Blob, thumb?: Blob, width, height, quad, rotation, filter, text?}
 */
export async function saveDoc(doc) {
  const db = await openDB();
  const now = Date.now();
  const id = doc.id || newId();
  const createdAt = doc.createdAt || now;

  const pages = doc.pages.map((p, i) => ({
    id: p.id || newId(),
    docId: id,
    index: i,
    source: p.source || p.jpeg || null,
    thumb: p.thumb || null,
    width: p.width,
    height: p.height,
    quad: p.quad || null,
    filter: p.filter || 'original',
    rotation: p.rotation || 0,
    text: p.text || '',
  }));

  const meta = {
    id,
    title: doc.title || '未命名文档',
    createdAt,
    updatedAt: now,
    pageCount: pages.length,
    thumb: pages[0]?.thumb || null,
  };

  await new Promise((resolve, reject) => {
    const t = tx(db, [STORE_DOCS, STORE_PAGES], 'readwrite');
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    const ds = t.objectStore(STORE_DOCS);
    const ps = t.objectStore(STORE_PAGES);

    ds.put(meta);

    // 先清掉旧页，再写入新页（编辑后页数可能减少）
    const idx = ps.index('byDoc');
    const cursorReq = idx.openKeyCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result;
      if (cur) {
        ps.delete(cur.primaryKey);
        cur.continue();
      } else {
        for (const p of pages) ps.put(p);
      }
    };
  });

  // 页面里若带文字，顺手更新全文索引
  return meta;
}

/** 读取一份完整文档 */
export async function loadDoc(id) {
  const db = await openDB();
  const t = tx(db, [STORE_DOCS, STORE_PAGES]);
  const meta = await wrap(t.objectStore(STORE_DOCS).get(id));
  if (!meta) return null;
  const pages = await wrap(t.objectStore(STORE_PAGES).index('byDoc').getAll(IDBKeyRange.only(id)));
  pages.sort((a, b) => a.index - b.index);
  return { ...meta, pages };
}

/** 文档列表（按更新时间倒序，只含元信息与缩略图） */
export async function listDocs() {
  const db = await openDB();
  const t = tx(db, STORE_DOCS);
  const all = await wrap(t.objectStore(STORE_DOCS).getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function removeDoc(id) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = tx(db, [STORE_DOCS, STORE_PAGES], 'readwrite');
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.objectStore(STORE_DOCS).delete(id);
    const idx = t.objectStore(STORE_PAGES).index('byDoc');
    const req = idx.openKeyCursor(IDBKeyRange.only(id));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        t.objectStore(STORE_PAGES).delete(cur.primaryKey);
        cur.continue();
      }
    };
  });
}

export async function clearAll() {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = tx(db, [STORE_DOCS, STORE_PAGES], 'readwrite');
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.objectStore(STORE_DOCS).clear();
    t.objectStore(STORE_PAGES).clear();
  });
}

/** 查询当前已占用空间（用于在设置里显示，让用户心里有数） */
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage: used = 0, quota = 0 } = await navigator.storage.estimate();
    return { used, quota };
  } catch {
    return null;
  }
}

/* ---------- 轻量设置（不使用 IndexedDB，读写同步、立即生效） ---------- */

const SETTINGS_KEY = 'scanfree.settings';

const DEFAULT_SETTINGS = {
  filter: 'magic',
  maxSize: 2400, // 长边最大像素，兼顾清晰度与体积
  quality: 0.9, // JPEG 质量
  pageSize: 'a4', // 导出 PDF 纸张
  ocrLang: 'chi_sim+eng',
  autoCrop: true,
  watermark: '',
  // 文字识别用哪个引擎：auto = 填了 Key 就走在线（DeepSeek），否则本地
  ocrEngine: 'auto', // auto | local | online
  // 用户自己的 DeepSeek Key，只存在本机 localStorage，不会发给任何人
  aiKey: '',
  aiModel: 'deepseek-flash',
};

export function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式下写入失败也不影响使用 */
  }
  return next;
}

export { DEFAULT_SETTINGS };
