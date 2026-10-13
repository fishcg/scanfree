/**
 * ocr.js —— 文字识别（OCR）。
 *
 * 这是唯一一个需要联网下载一次识别模型的功能（约 10~20MB，之后浏览器会缓存）。
 * 之所以不做成内置：识别引擎 Tesseract.js + 中文语言包体积远大于整个 App 本体，
 * 让不用这个功能的人白白下载几十 MB 是不划算的。
 *
 * 设计原则：
 *  - 懒加载：只有用户真的点了"识别文字"才去下载
 *  - 可降级：下载失败就明确告诉用户原因和替代方案，绝不让界面卡死
 *  - 可自建：CDN 地址集中在 CDN 常量里，内网部署时改一行即可
 */

const CDN = {
  worker: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
  lang: 'https://tessdata.projectnaptha.com/4.0.0',
};

/** 支持的语言（识别模型按需下载） */
export const OCR_LANGS = [
  { id: 'chi_sim+eng', name: '中文 + 英文', size: '约 20MB' },
  { id: 'chi_sim', name: '简体中文', size: '约 12MB' },
  { id: 'chi_tra+eng', name: '繁体中文 + 英文', size: '约 16MB' },
  { id: 'eng', name: 'English', size: '约 4MB' },
  { id: 'jpn', name: '日本語', size: '约 16MB' },
  { id: 'kor', name: '한국어', size: '约 12MB' },
];

let libPromise = null;
let currentWorker = null;
let currentLang = null;

/** 按需加载 Tesseract 库本体 */
function loadLib() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (libPromise) return libPromise;
  libPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CDN.worker.replace('/worker.min.js', '/tesseract.min.js');
    s.async = true;
    s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('识别库加载异常')));
    s.onerror = () =>
      reject(new Error('无法下载文字识别引擎，请检查网络后重试（也可以先把文字用"复制"功能手动整理）'));
    document.head.appendChild(s);
  }).catch((e) => {
    libPromise = null;
    throw e;
  });
  return libPromise;
}

/**
 * 识别一张图片里的文字。
 * @param {Blob|HTMLCanvasElement|ImageBitmap} source
 * @param {{lang?: string, onProgress?: (p:number, status:string)=>void}} [opts]
 * @returns {Promise<{text: string, confidence: number}>}
 */
export async function recognize(source, opts = {}) {
  const lang = opts.lang || 'chi_sim+eng';
  const Tesseract = await loadLib();

  if (!currentWorker || currentLang !== lang) {
    if (currentWorker) {
      try {
        await currentWorker.terminate();
      } catch {
        /* 忽略 */
      }
      currentWorker = null;
    }
    opts.onProgress?.(0.02, '正在加载识别模型');
    currentWorker = await Tesseract.createWorker(lang, 1, {
      workerPath: CDN.worker,
      corePath: CDN.core,
      langPath: CDN.lang,
      logger: (m) => {
        if (m.status === 'recognizing text' && typeof m.progress === 'number') {
          opts.onProgress?.(0.15 + m.progress * 0.85, '正在识别文字');
        } else if (m.status) {
          opts.onProgress?.(0.08, '正在加载识别模型');
        }
      },
    });
    currentLang = lang;
  }

  opts.onProgress?.(0.15, '正在识别文字');
  const { data } = await currentWorker.recognize(source);
  opts.onProgress?.(1, '识别完成');
  return {
    text: (data.text || '').replace(/\n{3,}/g, '\n\n').trim(),
    confidence: data.confidence || 0,
  };
}

/** 释放识别引擎占用的内存（页面隐藏、退出文档时调用） */
export async function terminate() {
  if (currentWorker) {
    try {
      await currentWorker.terminate();
    } catch {
      /* 忽略 */
    }
    currentWorker = null;
    currentLang = null;
  }
}

export function isReady() {
  return !!currentWorker;
}

export { CDN as OCR_CDN };
