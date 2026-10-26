// 五维雷达图组件（原生 Canvas 2D，无第三方依赖）
// 数据源：report.radar = [内容, 结构, 表达, 节奏, 专业度]（各 1-5 分）

/** 取设备像素比。
 *  修复：原先用 wx.getSystemInfoSync()，该接口自基础库 2.20.1 起已停止维护，
 *  官方推荐改用 wx.getDeviceInfo()；此处做兼容降级，取不到时用 2。
 *  注：小程序组件文件的 TS 处于全局作用域（未开 module），
 *  同名函数会与其他文件冲突，故用随机命名空间隔离。 */
const RADAR_PX_RATIO = (() => {
  const get = () => {
    try {
      const info = (wx as any).getDeviceInfo ? (wx as any).getDeviceInfo() : null;
      if (info && typeof info.pixelRatio === "number" && info.pixelRatio > 0) {
        return info.pixelRatio;
      }
    } catch (_) {
      // 忽略：降级到 getSystemInfoSync
    }
    try {
      const sys = wx.getSystemInfoSync();
      return sys.pixelRatio || 2;
    } catch (_) {
      return 2;
    }
  };
  return get;
})();

Component({
  properties: {
    radar: { type: Array, value: [3, 3, 3, 3, 3] },
    labels: { type: Array, value: ["内容", "结构", "表达", "节奏", "专业度"] },
  },

  observers: {
    "radar, labels"() {
      this.draw();
    },
  },

  lifetimes: {
    ready() {
      this.draw();
    },
  },

  methods: {
    draw() {
      const query = this.createSelectorQuery();
      query
        .select("#radar")
        .fields({ node: true, size: true })
        .exec((res) => {
          const info = res && res[0];
          if (!info || !info.node) return;
          const canvas = info.node;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          const dpr = RADAR_PX_RATIO();
          // 修复：给 canvas.width/height 赋值会重置变换矩阵，
          // 但如果本次未重新赋值（如尺寸未变），上一次的 ctx.scale(dpr,dpr)
          // 会与本次叠加，导致图形被放大 dpr² 倍。
          // 这里每次都显式重置变换，保证缩放只生效一次。
          if (canvas.width !== Math.round(info.width * dpr)) {
            canvas.width = Math.round(info.width * dpr);
            canvas.height = Math.round(info.height * dpr);
          }
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.scale(dpr, dpr);
          this.render(ctx, info.width, info.height);
        });
    },

    render(ctx: any, w: number, h: number) {
      ctx.clearRect(0, 0, w, h);
      // 修复：radar 与 labels 长度可能不一致（服务端数据缺项/多维），
      // 原实现直接按 radar.length 遍历，labels[i] 可能为 undefined → 画布上出现 "undefined 3"。
      // 这里取两者较小值作为维度数，并对数值做合法性归一。
      const srcRadar: any[] = Array.isArray(this.data.radar) ? this.data.radar : [];
      const srcLabels: any[] = Array.isArray(this.data.labels) ? this.data.labels : [];
      const n = Math.min(srcRadar.length, srcLabels.length);
      if (!n) return;
      const radar = srcRadar.slice(0, n).map((v) => {
        const num = Number(v);
        if (isNaN(num)) return 0;
        return Math.max(0, Math.min(5, num));
      });
      const labels = srcLabels.slice(0, n).map((v) => (v == null ? "" : String(v)));

      const cx = w / 2;
      const cy = h / 2;
      const r = Math.min(w, h) / 2 - 34;
      const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const point = (i: number, radius: number) => ({
        x: cx + radius * Math.cos(angle(i)),
        y: cy + radius * Math.sin(angle(i)),
      });

      // 网格（5 层同心多边形）
      ctx.strokeStyle = "#e2e8f0";
      ctx.lineWidth = 1;
      for (let level = 1; level <= 5; level++) {
        const rr = (r * level) / 5;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const p = point(i, rr);
          i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.stroke();
      }

      // 轴
      ctx.strokeStyle = "#e2e8f0";
      for (let i = 0; i < n; i++) {
        const p = point(i, r);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }

      // 数据多边形
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const p = point(i, (r * radar[i]) / 5);
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(37, 99, 235, 0.25)";
      ctx.fill();
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 2;
      ctx.stroke();

      // 数据点
      for (let i = 0; i < n; i++) {
        const p = point(i, (r * radar[i]) / 5);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI);
        ctx.fillStyle = "#2563eb";
        ctx.fill();
      }

      // 轴标签
      ctx.fillStyle = "#475569";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let i = 0; i < n; i++) {
        const p = point(i, r + 20);
        ctx.fillText(`${labels[i]} ${radar[i]}`, p.x, p.y);
      }
    },
  },
});
