/**
 * 全局配置。
 * 提交前务必填写 CLOUD_ENV（云开发环境 ID）。
 */

// 云开发环境 ID；留空则使用「默认环境」。正式提交需填写实际环境 ID。
export const CLOUD_ENV = "";

// 订阅消息模板 ID（公众平台申请后填写；留空则跳过授权，finalize 推送会静默失败）
// 注意：云函数 finalize 侧读的是同名环境变量 SUBSCRIBE_TEMPLATE_ID，两侧要填同一个值。
export const SUBSCRIBE_TEMPLATE_ID = "2Zn06BIC9A3qoLl53hm3yhVICpQVerh6X0hT-Pd0RCk";

// 场景定义（对应 FR-02 三类场景）
export interface SceneDef {
  key: string;
  label: string;
  desc: string;
  icon: string;
}

export const SCENES: SceneDef[] = [
  { key: "interview", label: "模拟面试", desc: "求职面试演练", icon: "🎤" },
  { key: "defense", label: "答辩预演", desc: "开题/毕业答辩", icon: "🎓" },
  { key: "presentation", label: "课堂展示", desc: "课堂/竞赛路演", icon: "📣" },
];

// 录音时限选项（分钟）
export const DURATION_OPTIONS = [1, 3, 5];

// 内容安全：统一由服务端 msgSecCheck fail-close 执行（asr / updateTranscript /
// genQuestions 内置 assertSafe），前端无独立开关。
