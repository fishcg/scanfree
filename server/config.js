/**
 * server/config.js —— 服务端配置。
 *
 * 与 ai-image 项目保持同一套约定：
 *   - 密钥只从**环境变量**读，配置文件本身可以放心的进 git（里面没有明文密钥）；
 *   - 线上真正的值放在 k8s 的 Secret / ConfigMap 里（见 k8s.yaml）。
 *
 * 本地跑：DEEPSEEK_API_KEY=sk-xxx npm start
 */
const config = {
  http: {
    port: Number(process.env.PORT || 7994),
  },

  deepseek: {
    // 没配就是没开通在线识别：接口会明确告诉前端「本站没开」，前端自动退回本地离线
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    timeout: Number(process.env.DEEPSEEK_TIMEOUT || 120000),
    maxTokens: Number(process.env.DEEPSEEK_MAX_TOKENS || 4096),
  },

  ocr: {
    // 前端已经压到 1568px / JPEG 0.86，正常一张在 300KB 上下；8MB 是很宽松的天花板
    maxImageBytes: Number(process.env.OCR_MAX_IMAGE_BYTES || 8 * 1024 * 1024),
    maxBodyBytes: Number(process.env.OCR_MAX_BODY_BYTES || 12 * 1024 * 1024),
    // 限流：Key 是站里掏钱的，不限流等于把钱包挂在公网上
    perHour: Number(process.env.OCR_PER_HOUR || 30),
    perDay: Number(process.env.OCR_PER_DAY || 200),
    globalPerDay: Number(process.env.OCR_GLOBAL_PER_DAY || 3000),
  },
};

export default config;
