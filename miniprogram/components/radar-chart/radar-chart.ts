// 五维雷达图组件（原生 Canvas 2D，无第三方依赖）
// 数据源：report.radar = [内容, 结构, 表达, 节奏, 专业度]（各 1-5 分）
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
          const dpr = wx.getSystemInfoSync().pixelRatio || 2;
          canvas.width = info.width * dpr;
          canvas.height = info.height * dpr;
          ctx.scale(dpr, dpr);
          this.render(ctx, info.width, info.height);
        });
    },

    render(ctx: any, w: number, h: number) {
      ctx.clearRect(0, 0, w, h);
      const radar: number[] = this.data.radar;
      const labels: string[] = this.data.labels;
      const n = radar.length;
      if (!n) return;

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
