// 出题页：随机抽题 / 自定义出题（上传材料 → AI 生成追问）
import type { IAppOption } from "../../app";
import { genQuestions, getQuestions } from "../../utils/api";

const app = getApp<IAppOption>();

Page({
  data: {
    scene: "interview",
    mode: "random",
    loading: false,
    question: "",
    questions: [] as any[],
    uploading: false,
    materialName: "",
  },

  onLoad(query: Record<string, string>) {
    const scene = query.scene || "interview";
    const mode = query.mode || "random";
    this.setData({ scene, mode });
    if (mode === "retry") {
      // 同题重练（第四轮）：沿用上一次的题目，便于直接对比改进效果，
      // 不再随机抽题。
      const preset = query.question ? decodeURIComponent(query.question) : "";
      this.setData({
        question: preset || "（原题缺失，请点击「换一题」重新抽题）",
        loading: false,
      });
      return;
    }
    if (mode === "random") this.loadRandom();
    else this.setData({ loading: false });
  },

  async loadRandom() {
    this.setData({ loading: true });
    try {
      // 云函数已开启鉴权，调用前确保 openid 就绪
      if (!app.globalData.openid) await app.login();
      const { questions } = await getQuestions({ scene: this.data.scene, limit: 1 });
      if (questions && questions.length) {
        this.setData({ question: questions[0].text });
      } else {
        this.setData({ question: "（题库为空，请先导入题目到 questions 集合）" });
      }
    } catch (e) {
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  onChange() {
    this.loadRandom();
  },

  // 自定义出题：选择材料文件
  onUploadMaterial() {
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      extension: ["txt", "md", "docx", "pdf"],
      success: async (res) => {
        const file = res.tempFiles[0];
        this.setData({ uploading: true, materialName: file.name });
        wx.showLoading({ title: "AI 生成追问中" });
        try {
          // openid 写入 cloudPath：云函数据此校验材料归属，
          // 防止他人拿到 fileID 后越权下载简历 / 项目材料
          let openid = app.globalData.openid;
          if (!openid) {
            await app.login();
            openid = app.globalData.openid;
          }
          if (!openid) throw new Error("登录失败，请重启小程序后重试");

          const upload = await wx.cloud.uploadFile({
            cloudPath: `materials/${openid}/${Date.now()}-${file.name}`,
            filePath: file.path,
          });
          const { questions } = await genQuestions({
            fileID: upload.fileID,
            scene: this.data.scene,
          });
          const list = (questions || []).map((q, i) => ({ ...q, index: i }));
          this.setData({ questions: list, question: list[0] ? list[0].question : "" });
        } catch (e: any) {
          wx.showToast({ title: e.message || "出题失败", icon: "none" });
        } finally {
          wx.hideLoading();
          this.setData({ uploading: false });
        }
      },
    });
  },

  onPickQuestion(e: WechatMiniprogram.TouchEvent) {
    const q = this.data.questions[e.currentTarget.dataset.index as number];
    this.setData({ question: q.question });
  },

  onGo() {
    if (!this.data.question) return;
    wx.navigateTo({
      url: `/pages/record/record?scene=${this.data.scene}&question=${encodeURIComponent(this.data.question)}`,
    });
  },
});
