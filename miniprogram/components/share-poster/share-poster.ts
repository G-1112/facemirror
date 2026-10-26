// 分享海报组件（FR-11）：Canvas 绘制雷达 + 总分 + 文案，可保存相册
// 小程序码需通过服务端 wxacode.getUnlimited 生成后贴入（见 README）

import { createNavGuard, NavGuard } from "../../utils/nav-guard";

/** 取设备像素比（wx.getSystemInfoSync 自 2.20.1 起停止维护，优先用 getDeviceInfo）。
 *  注：小程序组件文件的 TS 处于全局作用域（未开 module），
 *  同名函数会与其他文件冲突，故用独立命名隔离。 */
const POSTER_PX_RATIO = (() => {
  const get = () => {
    try {
      const info = (wx as any).getDeviceInfo ? (wx as any).getDeviceInfo() : null;
      if (info && typeof info.pixelRatio === "number" && info.pixelRatio > 0) {
        return info.pixelRatio;
      }
    } catch (_) {
      // 降级
    }
    try {
      return wx.getSystemInfoSync().pixelRatio || 2;
    } catch (_) {
      return 2;
    }
  };
  return get;
})();

Component({
  properties: {
    score: { type: Number, value: 0 },
    radar: { type: Array, value: [3, 3, 3, 3, 3] },
    labels: { type: Array, value: ["内容", "结构", "表达", "节奏", "专业度"] },
  },

  data: {
    saving: false,
  },

  lifetimes: {
    attached() {
      // 保存防重入守卫。
      // ⚠️ 原本用 `disabled="{{saving}}"` + `if (this.data.saving) return;` 双重拦截，
      // 一旦 saving 卡在 true，按钮就**永久变灰点不动**（2026-10-26 同族事故）。
      // 现在按钮永不禁用，防重入交给时间戳锁（自动过期，永不永久卡死）。
      //
      // 注：Component() 的 TS 类型不接受顶层自定义字段，故挂到实例上（any 断言）。
      (this as any)._guard = createNavGuard({
        onLockChange: (locked) => {
          this.setData({ saving: locked });
        },
      });
    },
    detached() {
      // 组件销毁：清理看门狗，避免销毁后仍触发 setData
      const g = (this as any)._guard as NavGuard | null;
      if (g) g.dispose();
      (this as any)._guard = null;
    },
  },

  methods: {
    async save() {
      // 防重复点击：生成海报期间忽略再次点击，否则会并发写同一 canvas
      const guard = (this as any)._guard as NavGuard | null;
      if (!guard || !guard.tryLock()) return;
      try {
        // 修复：原先 getCanvasNode() 与 getCanvasSize() 各自发一次
        // createSelectorQuery，重复查询同一节点。合并为一次查询。
        const { node, width, height } = await this.getCanvasInfo();
        if (!node) throw new Error("canvas not ready");
        const dpr = POSTER_PX_RATIO();
        node.width = Math.round(width * dpr);
        node.height = Math.round(height * dpr);
        const ctx = node.getContext("2d");
        if (!ctx) throw new Error("canvas context unavailable");
        // 修复：设置 canvas.width/height 会重置变换矩阵，
        // 必须显式重置后再 scale，避免多次保存时缩放叠加。
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        this.drawPoster(ctx, width, height);

        // 延迟确保绘制完成
        setTimeout(() => {
          wx.canvasToTempFilePath({
            canvas: node,
            success: (res) => {
              wx.saveImageToPhotosAlbum({
                filePath: res.tempFilePath,
                success: () => {
                  wx.showToast({ title: "已保存到相册" });
                  // ⚠️ 成功分支也必须解锁：漏了会导致 saving 永久为 true，
                  //    按钮再也无法再次使用。
                  this._unlock();
                },
                fail: (e: any) => {
                  // 修复：原先一律提示「保存失败」，但用户拒绝相册授权时
                  // 真实原因被掩盖，用户无法自行解决。给出明确指引。
                  const msg = e?.errMsg || "";
                  if (msg.includes("auth deny") || msg.includes("authorize")) {
                    wx.showModal({
                      title: "需要相册权限",
                      content: "保存海报需要相册读写权限，请在设置中开启后重试。",
                      showCancel: false,
                    });
                  } else {
                    wx.showToast({ title: "保存失败", icon: "none" });
                  }
                  this._unlock();
                },
              });
            },
            fail: () => {
              wx.showToast({ title: "生成失败", icon: "none" });
              this._unlock();
            },
          }, this);
        }, 100);
      } catch (e) {
        this._unlock();
        wx.showToast({ title: "生成失败", icon: "none" });
      }
    },

    /** 解锁（清看门狗 + 复位视觉态） */
    _unlock() {
      const g = (this as any)._guard as NavGuard | null;
      if (g) g.unlock();
    },

    /** 一次性取到 canvas 节点与其尺寸（合并原先的两次查询） */
    getCanvasInfo(): Promise<{ node: any; width: number; height: number }> {
      return new Promise((resolve, reject) => {
        this.createSelectorQuery()
          .select("#poster")
          .fields({ node: true, size: true })
          .exec((res) => {
            const info = res && res[0];
            if (info && info.node) {
              resolve({ node: info.node, width: info.width || 0, height: info.height || 0 });
            } else {
              reject(new Error("canvas not ready"));
            }
          });
      });
    },

    drawPoster(ctx: any, w: number, h: number) {
      const { score, radar, labels } = this.data;
      // 背景
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      // 顶部色带
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, "#2563eb");
      grad.addColorStop(1, "#7c3aed");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h * 0.18);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 20px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("面镜 · 表达能力评估", 20, h * 0.1 + 10);

      // 总分
      ctx.fillStyle = "#1f2937";
      ctx.textAlign = "center";
      ctx.font = "bold 56px sans-serif";
      ctx.fillText(String(score), w / 2, h * 0.34);
      ctx.font = "14px sans-serif";
      ctx.fillStyle = "#6b7280";
      ctx.fillText("综合得分 / 100", w / 2, h * 0.34 + 24);

      // 雷达图（简化）
      // 修复：radar/labels 长度可能不一致或含非法值，
      // 原实现直接用 radar.length 做除数（为 0 时得 NaN，画布绘制异常）。
      const srcRadar: any[] = Array.isArray(radar) ? radar : [];
      const srcLabels: any[] = Array.isArray(labels) ? labels : [];
      const n = Math.min(srcRadar.length, srcLabels.length);
      if (!n) {
        ctx.fillStyle = "#9ca3af";
        ctx.font = "12px sans-serif";
        ctx.fillText("暂无雷达数据", w / 2, h * 0.55);
        return;
      }
      const vals = srcRadar.slice(0, n).map((v) => {
        const num = Number(v);
        if (isNaN(num)) return 0;
        return Math.max(0, Math.min(5, num));
      });
      const names = srcLabels.slice(0, n).map((v) => (v == null ? "" : String(v)));

      const cx = w / 2;
      const cy = h * 0.55;
      const r = Math.min(w, h) * 0.24;
      const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const pt = (i: number, rad: number) => ({ x: cx + rad * Math.cos(angle(i)), y: cy + rad * Math.sin(angle(i)) });

      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 1;
      for (let level = 1; level <= 5; level++) {
        const rr = (r * level) / 5;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const p = pt(i, rr);
          i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.stroke();
      }
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const p = pt(i, (r * vals[i]) / 5);
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(37, 99, 235, 0.25)";
      ctx.fill();
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = "#475569";
      ctx.font = "11px sans-serif";
      for (let i = 0; i < n; i++) {
        const p = pt(i, r + 16);
        ctx.fillText(names[i], p.x, p.y);
      }

      // 底部 slogan
      ctx.fillStyle = "#9ca3af";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("对着手机说 3 分钟，60 秒拿到能力雷达图", w / 2, h - 30);
    },
  },
});
