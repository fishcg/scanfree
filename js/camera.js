/**
 * camera.js —— 相机取景与连续拍摄。
 *
 * 复刻扫描仪 App 最好用的那个体验：打开就是取景框，按一下拍一页，
 * 拍完不停留在相册里翻，而是原地接着拍下一页，退出时一次性处理。
 *
 * 兼容性处理：
 *  - 优先申请后置摄像头 + 最高分辨率（ideal 4000px 长边）
 *  - 支持手电筒（torch）就显示按钮，不支持就隐藏
 *  - 支持变焦（zoom）就显示滑杆
 *  - 不支持 getUserMedia（老浏览器 / 非 HTTPS / 用户拒绝）→ 自动降级到系统相机
 */

import { $, icon, toast, haptic } from './ui.js';

const IDEAL_WIDTH = 3840;
const IDEAL_HEIGHT = 2160;

export class CameraView {
  /**
   * @param {HTMLElement} root 容器（#camera）
   * @param {{onCapture:(blob:Blob)=>Promise<void>|void, onClose:()=>void}} opts
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.onCapture = opts.onCapture || (() => {});
    this.onClose = opts.onClose || (() => {});
    this.stream = null;
    this.track = null;
    this.facing = 'environment';
    this.caps = {};
    this.shots = []; // 本次连拍缩略图
    this.busy = false;
    this._onKey = this._onKey.bind(this);
  }

  static get supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /** 打开相机。失败时抛错，由调用方降级处理 */
  async open() {
    this.root.hidden = false;
    this.root.innerHTML = this._template();
    this._bind();
    document.addEventListener('keydown', this._onKey);
    await this._start();
  }

  _template() {
    return `
      <div class="camera__viewport">
        <video class="camera__video" playsinline autoplay muted></video>
        <div class="camera__grid"></div>
        <div class="camera__flash"></div>
        <div class="camera__top">
          <button class="iconbtn" data-act="close" title="关闭">${icon('close')}</button>
          <div class="camera__hint" data-el="hint">把纸张放进取景框，尽量铺平</div>
          <button class="iconbtn" data-act="torch" title="闪光灯" hidden>${icon('sun')}</button>
        </div>
      </div>
      <div class="camera__bottom">
        <div class="camera__side">
          <button class="iconbtn" data-act="switch" title="切换摄像头">${icon('swap')}</button>
        </div>
        <button class="shutter" data-act="shoot" title="拍摄"></button>
        <div class="camera__side">
          <div class="camera__thumbs" data-el="thumbs"></div>
          <button class="iconbtn" data-act="done" title="完成">${icon('check')}</button>
          <span>完成</span>
        </div>
      </div>`;
  }

  _bind() {
    this.root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'close') this.close();
      else if (act === 'shoot') this.shoot();
      else if (act === 'done') this.close();
      else if (act === 'switch') this._switch();
      else if (act === 'torch') this._toggleTorch(btn);
    });
  }

  async _start() {
    const video = this.root.querySelector('.camera__video');
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: this.facing },
        width: { ideal: IDEAL_WIDTH },
        height: { ideal: IDEAL_HEIGHT },
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = this.stream;
    await video.play().catch(() => {});
    this.track = this.stream.getVideoTracks()[0];
    const settings = this.track.getSettings?.() || {};
    this.caps = this.track.getCapabilities?.() || {};

    // 有手电筒才显示按钮
    if (this.caps.torch) {
      this.root.querySelector('[data-act="torch"]').hidden = false;
    }
    const hint = this.root.querySelector('[data-el="hint"]');
    if (settings.width) {
      const mp = ((settings.width * settings.height) / 1e6).toFixed(1);
      hint.textContent = `${settings.width}×${settings.height}（${mp}MP）· 纸张尽量铺平`;
    }
  }

  async _switch() {
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    this._stopStream();
    try {
      await this._start();
    } catch (err) {
      toast('切换摄像头失败，已回到默认摄像头', 'warn');
      this.facing = 'environment';
      await this._start().catch(() => this.close());
    }
  }

  async _toggleTorch(btn) {
    if (!this.track || !this.caps.torch) return;
    const on = !this.torchOn;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: on }] });
      this.torchOn = on;
      btn.style.color = on ? '#fbbf24' : '#fff';
    } catch {
      toast('这台设备的闪光灯不可用', 'warn');
    }
  }

  /** 拍一张：把当前画面画到 Canvas 后转成 JPEG Blob */
  async shoot() {
    if (this.busy || !this.stream) return;
    this.busy = true;
    const video = this.root.querySelector('.camera__video');
    const flash = this.root.querySelector('.camera__flash');
    const btn = this.root.querySelector('[data-act="shoot"]');

    try {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) throw new Error('相机还没准备好，请稍等一下');
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, w, h);

      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('拍照失败'))), 'image/jpeg', 0.94)
      );

      flash.classList.remove('fire');
      void flash.offsetWidth;
      flash.classList.add('fire');
      haptic(14);
      btn.disabled = true;

      // 立刻把缩略图放到左下角，让用户知道"这一张已经进去了"
      const url = URL.createObjectURL(blob);
      this.shots.push(url);
      const thumbs = this.root.querySelector('[data-el="thumbs"]');
      thumbs.innerHTML = this.shots
        .slice(-3)
        .map((u) => `<img src="${u}" alt="已拍"/>`)
        .join('');

      await this.onCapture(blob);
    } catch (err) {
      toast(err.message || '拍照失败', 'error');
    } finally {
      this.busy = false;
      btn.disabled = false;
    }
  }

  _onKey(e) {
    if (this.root.hidden) return;
    if (e.key === 'Escape') this.close();
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      this.shoot();
    }
  }

  _stopStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.track = null;
      this.torchOn = false;
    }
  }

  close() {
    this._stopStream();
    document.removeEventListener('keydown', this._onKey);
    this.shots.forEach((u) => URL.revokeObjectURL(u));
    this.shots = [];
    this.root.hidden = true;
    this.root.innerHTML = '';
    this.onClose();
  }

  /** 显示"相机不可用"的说明与降级入口 */
  static showFallback(root, message, onPickFile) {
    root.hidden = false;
    root.classList.add('camera--error');
    root.innerHTML = `
      <div class="camera__viewport" style="flex-direction:column;gap:14px">
        <div style="font-size:44px">📷</div>
        <div style="max-width:320px;line-height:1.8;font-size:14px">${message}</div>
        <button class="btn btn--primary" data-act="file">用系统相机 / 从相册选</button>
        <button class="btn btn--ghost" style="color:#fff;border-color:rgba(255,255,255,.3)" data-act="close">返回</button>
      </div>`;
    root.querySelector('[data-act="file"]').onclick = () => {
      root.hidden = true;
      root.classList.remove('camera--error');
      root.innerHTML = '';
      onPickFile?.();
    };
    root.querySelector('[data-act="close"]').onclick = () => {
      root.hidden = true;
      root.classList.remove('camera--error');
      root.innerHTML = '';
    };
  }
}

/** 判断错误是不是"用户拒绝授权"，用于给出更准确的提示 */
export function describeCameraError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError') return '你拒绝了摄像头权限。可以在浏览器地址栏的权限设置里重新允许，或直接用系统相机拍照后导入。';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有找到可用的摄像头。可以直接用系统相机拍照，然后从相册导入。';
  if (!location.protocol.startsWith('https') && location.hostname !== 'localhost') {
    return '浏览器只允许在 HTTPS 或 localhost 下调用摄像头。当前是普通 HTTP 访问，请改用系统相机拍照后导入。';
  }
  return `摄像头打不开：${err?.message || '未知原因'}。可以直接用系统相机拍照后导入。`;
}
