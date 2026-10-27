// 深度面试 · 第 1 步：简历上传 → 结构化解析 → 用户确认/修正 → 岗位分析 → 生成题
//
// 状态机（page-level，跨页状态另存云端 interviews 集合）：
//   idle ──上传──> uploading ──解析──> parsing ──成功──> reviewing
//                                            └──失败──> idle(带错误+重试)
//   reviewing ──岗位分析──> jobFilling ──生成题──> generating ──成功──> ready(跳 deep 页)
//   reviewing ──重新解析──> parsing
//
// 铁律（见项目档案「状态锁铁律」）：
//   ① 按钮永不用 disabled 做防重入，flag 只做视觉反馈
//   ② 每个置 true 的 flag 至少 2 处置回 false
//   ③ 业务前置（没解析/没填岗位/题数不足）→ JS 拦截 + 可操作提示
import {
  parseResume,
  analyzeJob,
  genDeepQuestions,
  createDeepSession,
  updateDeepSession,
  showCallError,
  errorText,
} from "../../utils/api";
import { createNavGuard, NavGuard } from "../../utils/nav-guard";
import {
  CompetencyModel,
  InterviewQuestion,
  JobProfile,
  ResumeProfile,
  MIN_QUESTIONS,
  MAX_QUESTIONS,
  dimensionName,
} from "../../utils/interview";

/** 简历上传格式白名单：必须与服务端 parseResume 的 ALLOWED_EXT_RE 一致 */
const RESUME_EXTENSIONS = ["txt", "md", "docx", "pdf"];

/** 简历的**扁平**视图类型（数组字段已 join 成字符串，模板不能深层访问） */
interface ResumeView {
  education: {
    idx: number;
    school: string;
    major: string;
    degree: string;
    period: string;
    highlights: string;
  }[];
  experiences: {
    idx: number;
    org: string;
    role: string;
    period: string;
    duties: string;
    achievements: string;
  }[];
  projects: {
    idx: number;
    name: string;
    role: string;
    period: string;
    tech: string;
    desc: string;
    metrics: string;
    highlights: string;
  }[];
  awards: {
    idx: number;
    name: string;
    level: string;
    period: string;
    issuer: string;
  }[];
  skills: {
    languages: string;
    frameworks: string;
    tools: string;
    concepts: string;
    other: string;
  };
}

/** 把结构化简历转成**扁平**数组再 setData（模板深层访问在字段缺失时会渲染 undefined） */
function toResumeView(resume: ResumeProfile | null): ResumeView {
  const r = resume || ({} as ResumeProfile);
  return {
    education: (r.education || []).map((e, i) => ({
      idx: i,
      school: e.school || "（未填写）",
      major: e.major || "",
      degree: e.degree || "",
      period: e.period || "",
      highlights: (e.highlights || []).join("；"),
    })),
    experiences: (r.experiences || []).map((e, i) => ({
      idx: i,
      org: e.org || "（未填写）",
      role: e.role || "",
      period: e.period || "",
      duties: (e.duties || []).join("；"),
      achievements: (e.achievements || []).join("；"),
    })),
    projects: (r.projects || []).map((p, i) => ({
      idx: i,
      name: p.name || "（未填写）",
      role: p.role || "",
      period: p.period || "",
      tech: (p.tech || []).join("、"),
      desc: p.desc || "",
      metrics: (p.metrics || []).join("、"),
      highlights: (p.highlights || []).join("；"),
    })),
    awards: (r.awards || []).map((a, i) => ({
      idx: i,
      name: a.name || "（未填写）",
      level: a.level || "",
      period: a.period || "",
      issuer: a.issuer || "",
    })),
    skills: {
      languages: (r.skills && r.skills.languages ? r.skills.languages : []).join("、"),
      frameworks: (r.skills && r.skills.frameworks ? r.skills.frameworks : []).join("、"),
      tools: (r.skills && r.skills.tools ? r.skills.tools : []).join("、"),
      concepts: (r.skills && r.skills.concepts ? r.skills.concepts : []).join("、"),
      other: (r.skills && r.skills.other ? r.skills.other : []).join("、"),
    },
  };
}

/** 岗位信息 → 扁平视图（模板只渲染字符串） */
function toJobView(job: JobProfile | null) {
  const j = job || ({} as JobProfile);
  return {
    role: j.role || "",
    level: j.level || "",
    industry: j.industry || "",
    extra: j.extra || "",
  };
}

/** 能力标准 → 扁平视图 */
function toCompetencyView(c: CompetencyModel | null) {
  return {
    role: c ? c.role : "",
    level: c ? c.level : "",
    industry: c ? c.industry : "",
    interviewerStyle: c ? c.interviewerStyle : "",
    competencies: ((c && c.competencies) || []).map((x) => ({
      key: x.key,
      name: x.name || dimensionName(x.key),
      weight: Math.round((x.weight || 0) * 100),
      focusPoints: (x.focusPoints || []).join("；"),
      expectedLevel: x.expectedLevel || "",
    })),
  };
}

Page({
  data: {
    // ---- 阶段 ----
    step: "upload" as "upload" | "review" | "job" | "ready",
    uploading: false,
    parsing: false,
    analyzingJob: false,
    generating: false,
    // ---- 简历 ----
    resume: null as ResumeProfile | null,
    resumeView: toResumeView(null),
    resumeWarnings: [] as string[],
    parseMode: "" as "" | "ai" | "rule",
    fileName: "",
    // 用户修正（可编辑文本，保存时回写结构化数据）
    editSummary: "",
    editSkills: "",
    // ---- 岗位 ----
    job: null as JobProfile | null,
    jobView: toJobView(null),
    competencyView: toCompetencyView(null),
    // ---- 题目 ----
    questions: [] as InterviewQuestion[],
    questionCount: 0,
    countWarning: "",
    // ---- 错误与导航 ----
    errorMsg: "",
    loadFailed: false,
    interviewId: "",
    navigating: false,
  },

  alive: true,
  _guard: null as NavGuard | null,
  /** 看门狗：任何异步阶段卡住都能兜底退出 loading */
  _watchdog: null as number | null,

  onLoad() {
    this.alive = true;
    this._guard = createNavGuard({
      onLockChange: (locked) => {
        if (this.alive) this.setData({ navigating: locked });
      },
    });
  },

  onShow() {
    if (this._guard) this._guard.unlock();
  },

  onUnload() {
    this.alive = false;
    this.clearWatchdog();
    if (this._guard) this._guard.dispose();
  },

  clearWatchdog() {
    if (this._watchdog !== null) {
      clearTimeout(this._watchdog);
      this._watchdog = null;
    }
  },

  /** 统一看门狗：超时后强制把当前 loading flag 归位并给出可操作提示 */
  armWatchdog(stage: "uploading" | "parsing" | "analyzingJob" | "generating", ms = 45000) {
    this.clearWatchdog();
    this._watchdog = setTimeout(() => {
      this._watchdog = null;
      if (!this.alive) return;
      this.setData({
        uploading: false,
        parsing: false,
        analyzingJob: false,
        generating: false,
        errorMsg: "操作超时，请检查网络后重试",
        loadFailed: true,
      });
    }, ms) as unknown as number;
  },

  // ------------------------------------------------------------ 上传 + 解析
  onPickResume() {
    // 业务前置：正在上传/解析中 → 提示而不是排队
    if (this.data.uploading || this.data.parsing) {
      wx.showToast({ title: "正在处理中，请稍候", icon: "none" });
      return;
    }
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      extension: RESUME_EXTENSIONS,
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) {
          wx.showToast({ title: "未选择到文件", icon: "none" });
          return;
        }
        this.uploadAndParse(file);
      },
      fail: (err: any) => {
        const msg = err && err.errMsg ? err.errMsg : "";
        if (msg.includes("cancel")) return; // 用户主动取消不算错误
        wx.showToast({ title: "选择文件失败，请重试", icon: "none" });
      },
    });
  },

  async uploadAndParse(file: any) {
    this.setData({ uploading: true, parsing: false, errorMsg: "", loadFailed: false, fileName: file.name });
    this.armWatchdog("uploading", 60000);
    try {
      // openid 写入 cloudPath：云函数据此校验文件归属，防越权下载他人简历
      const app = getApp<any>();
      let openid = app.globalData && app.globalData.openid;
      if (!openid) {
        await app.login();
        openid = app.globalData && app.globalData.openid;
      }
      if (!openid) throw new Error("登录失败，请重启小程序后重试");

      const upload = await wx.cloud.uploadFile({
        cloudPath: `resumes/${openid}/${Date.now()}-${file.name}`,
        filePath: file.path,
      });

      if (!this.alive) return;
      this.setData({ uploading: false, parsing: true });
      this.armWatchdog("parsing", 90000);

      const { resume } = await parseResume({ fileID: upload.fileID });
      if (!this.alive) return;

      if (!resume) {
        this.setData({ parsing: false, errorMsg: "简历解析未返回结果，请重试", loadFailed: true });
        return;
      }

      this.setData({
        parsing: false,
        resume,
        resumeView: toResumeView(resume),
        resumeWarnings: (resume.parseWarnings || []).slice(0, 5),
        parseMode: resume.parseMode || "ai",
        editSummary: resume.summary || "",
        editSkills: this.joinSkills(resume),
        step: "review",
        loadFailed: false,
      });

      // 规则兜底解析时必须明确提示用户「AI 不可用，请仔细核对」
      if (resume.parseMode === "rule") {
        wx.showModal({
          title: "已用规则识别",
          content: "AI 解析暂不可用，已按关键词规则识别简历结构。请逐项核对并修正，识别不准确会直接影响出题质量。",
          showCancel: false,
          confirmText: "我知道了",
        });
      }
    } catch (e: any) {
      if (!this.alive) return;
      this.setData({ uploading: false, parsing: false, errorMsg: errorText(e, "简历解析失败"), loadFailed: true });
      showCallError(e, "简历解析失败");
    } finally {
      this.clearWatchdog();
      if (this.alive) {
        this.setData({ uploading: false, parsing: false });
      }
    }
  },

  joinSkills(resume: ResumeProfile): string {
    const s = resume.skills || ({} as ResumeProfile["skills"]);
    return [s.languages, s.frameworks, s.tools, s.concepts, s.other]
      .map((x) => (x || []).join("、"))
      .filter(Boolean)
      .join(" / ");
  },

  /** 重新解析（换文件） */
  onReparse() {
    this.onPickResume();
  },

  // ------------------------------------------------------------ 用户修正
  onEditSummary(e: WechatMiniprogram.Input) {
    this.setData({ editSummary: e.detail.value });
  },

  onEditSkills(e: WechatMiniprogram.Input) {
    this.setData({ editSkills: e.detail.value });
  },

  /** 把用户修正写回结构化简历（仅覆盖概述与技能，保持其余结构不变） */
  applyEdits(): ResumeProfile | null {
    const r = this.data.resume;
    if (!r) return null;
    const skillsText = (this.data.editSkills || "")
      .split(/[\/、,，;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      ...r,
      summary: (this.data.editSummary || "").trim(),
      skills: {
        languages: [],
        frameworks: [],
        tools: skillsText,
        concepts: [],
        other: [],
      },
    };
  },

  // ------------------------------------------------------------ 岗位
  onJobInput(e: WechatMiniprogram.Input) {
    const key = e.currentTarget.dataset.key as string;
    this.setData({ [`jobView.${key}`]: e.detail.value } as any);
  },

  async onAnalyzeJob() {
    // ── 业务前置：必须先有解析结果 ──
    if (!this.data.resume) {
      wx.showToast({ title: "请先上传并解析简历", icon: "none" });
      return;
    }
    if (this.data.analyzingJob) {
      wx.showToast({ title: "正在分析中，请稍候", icon: "none" });
      return;
    }
    const job: JobProfile = {
      role: (this.data.jobView.role || "").trim(),
      level: (this.data.jobView.level || "").trim(),
      industry: (this.data.jobView.industry || "").trim(),
      extra: (this.data.jobView.extra || "").trim(),
    };
    if (!job.role) {
      wx.showToast({ title: "请填写目标岗位名称", icon: "none" });
      return;
    }

    this.setData({ analyzingJob: true, errorMsg: "", loadFailed: false });
    this.armWatchdog("analyzingJob", 60000);
    try {
      const { competency } = await analyzeJob({ job });
      if (!this.alive) return;
      if (!competency) throw new Error("岗位分析未返回结果");
      this.setData({
        analyzingJob: false,
        job,
        competencyView: toCompetencyView(competency),
        step: "job",
      });
    } catch (e: any) {
      if (!this.alive) return;
      this.setData({ analyzingJob: false, errorMsg: errorText(e, "岗位分析失败"), loadFailed: true });
      showCallError(e, "岗位分析失败");
    } finally {
      this.clearWatchdog();
      if (this.alive) this.setData({ analyzingJob: false });
    }
  },

  // ------------------------------------------------------------ 生成题目
  async onGenerateQuestions() {
    const resume = this.applyEdits();
    if (!resume) {
      wx.showToast({ title: "请先上传并解析简历", icon: "none" });
      return;
    }
    if (!this.data.job) {
      wx.showToast({ title: "请先分析目标岗位", icon: "none" });
      return;
    }
    if (this.data.generating) {
      wx.showToast({ title: "正在生成题目，请稍候", icon: "none" });
      return;
    }

    this.setData({ generating: true, errorMsg: "", loadFailed: false });
    this.armWatchdog("generating", 120000);
    try {
      // 先建会话（跨页状态载体）
      let interviewId = this.data.interviewId;
      if (!interviewId) {
        const created = await createDeepSession();
        if (!created || !created.interviewId) throw new Error("创建面试会话失败");
        interviewId = created.interviewId;
        if (!this.alive) return;
        this.setData({ interviewId });
      }

      const res = await genDeepQuestions({
        resume,
        job: this.data.job,
        competency: this.data.competencyView
          ? ({
              role: this.data.competencyView.role,
              level: this.data.competencyView.level,
              industry: this.data.competencyView.industry,
              interviewerStyle: this.data.competencyView.interviewerStyle,
              competencies: this.data.competencyView.competencies.map((c) => ({
                key: c.key,
                name: c.name,
                weight: c.weight / 100,
                focusPoints: c.focusPoints ? c.focusPoints.split("；").filter(Boolean) : [],
                expectedLevel: c.expectedLevel,
              })),
            } as CompetencyModel)
          : ({} as CompetencyModel),
      });
      if (!this.alive) return;

      const questions = (res && res.questions) || [];
      // ★数量异常处理：低于下限 → 明确告知，不静默放行
      if (questions.length < MIN_QUESTIONS) {
        this.setData({
          generating: false,
          errorMsg: `题目数量不足（${questions.length}/${MIN_QUESTIONS}），请补充简历信息后重新生成`,
          loadFailed: true,
        });
        wx.showModal({
          title: "题目数量不足",
          content: `当前只生成了 ${questions.length} 道题，少于要求的 ${MIN_QUESTIONS} 道。可能是简历信息太少，请回到上一步补充项目/经历细节后重新生成。`,
          showCancel: false,
          confirmText: "去补充简历",
        });
        return;
      }

      // 保存到云端会话
      await updateDeepSession({ interviewId, resume, job: this.data.job, questions });
      if (!this.alive) return;

      this.setData({
        generating: false,
        questions,
        questionCount: questions.length,
        countWarning: (res && res.countWarning) || "",
        step: "ready",
      });
    } catch (e: any) {
      if (!this.alive) return;
      this.setData({ generating: false, errorMsg: errorText(e, "生成题目失败"), loadFailed: true });
      showCallError(e, "生成题目失败");
    } finally {
      this.clearWatchdog();
      if (this.alive) this.setData({ generating: false });
    }
  },

  // ------------------------------------------------------------ 进入答题
  onStartInterview() {
    // 业务前置
    if (!this.data.interviewId) {
      wx.showToast({ title: "请先生成题目", icon: "none" });
      return;
    }
    if (this.data.questionCount < MIN_QUESTIONS) {
      wx.showToast({ title: `题目不足 ${MIN_QUESTIONS} 道，请重新生成`, icon: "none" });
      return;
    }
    if (this.data.questionCount > MAX_QUESTIONS) {
      wx.showToast({ title: `题目超过 ${MAX_QUESTIONS} 道，请重新生成`, icon: "none" });
      return;
    }
    // 防重入
    if (!this._guard || !this._guard.tryLock()) return;

    wx.navigateTo({
      url: `/pages/deep/deep?interviewId=${this.data.interviewId}`,
      success: () => {
        if (this._guard) this._guard.unlock();
      },
      fail: () => {
        if (this._guard) this._guard.unlock();
        wx.showToast({ title: "页面打开失败，请重试", icon: "none" });
      },
    });
  },

  onBackToUpload() {
    this.setData({ step: "upload", errorMsg: "", loadFailed: false });
  },
});
