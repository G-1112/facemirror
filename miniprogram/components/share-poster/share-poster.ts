// 分享海报组件（FR-11）：Canvas 绘制雷达 + 总分 + 文案，可保存相册
// 小程序码需通过服务端 wxacode.getUnlimited 生成后贴入（见 README）
Component({
  properties: {
    score: { type: Number, value: 0 },
    radar: { type: Array, value: [3, 3, 3, 3, 3] },
    labels: { type: Array, value: ["内容", "结构", "表达", "节奏", "专业度"] },
  },

  data: {
    saving: false,
  },

  methods: {
    async save() {
      this.setData({ saving: true });
      try {
        const canvas = await this.getCanvasNode();
        const { width, height } = await this.getCanvasSize();
        const dpr = wx.getSystemInfoSync().pixelRatio || 2;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        const ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);
        this.drawPoster(ctx, width, height);

        // 延迟确保绘制完成
        setTimeout(() => {
          wx.canvasToTempFilePath({
            canvas,
            success: (res) => {
              wx.saveImageToPhotosAlbum({
                filePath: res.tempFilePath,
                success: () => wx.showToast({ title: "已保存到相册" }),
                fail: () => wx.showToast({ title: "保存失败", icon: "none" }),
              });
              this.setData({ saving: false });
            },
            fail: () => {
              wx.showToast({ title: "生成失败", icon: "none" });
              this.setData({ saving: false });
            },
          }, this);
        }, 100);
      } catch (e) {
        this.setData({ saving: false });
        wx.showToast({ title: "生成失败", icon: "none" });
      }
    },

    getCanvasNode(): Promise<any> {
      return new Promise((resolve, reject) => {
        this.createSelectorQuery()
          .select("#poster")
          .fields({ node: true, size: true })
          .exec((res) => {
            if (res && res[0] && res[0].node) resolve(res[0].node);
            else reject(new Error("canvas not ready"));
          });
      });
    },

    getCanvasSize(): Promise<{ width: number; height: number }> {
      return new Promise((resolve, reject) => {
        this.createSelectorQuery()
          .select("#poster")
          .fields({ node: true, size: true })
          .exec((res) => {
            if (res && res[0]) resolve({ width: res[0].width, height: res[0].height });
            else reject(new Error("canvas not ready"));
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
      const n = radar.length;
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
        const p = pt(i, (r * radar[i]) / 5);
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
        ctx.fillText(labels[i], p.x, p.y);
      }

      // 底部 slogan
      ctx.fillStyle = "#9ca3af";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("对着手机说 3 分钟，60 秒拿到能力雷达图", w / 2, h - 30);
    },
  },
});
