// skills/facemirror/index.js — 原子接口注册入口
// require 导入名 = registerAPI 第一参数 = mcp.json name（三者必须一致）
const { drawQuestion } = require("./apis/drawQuestion");
const { getPracticeHistory } = require("./apis/getPracticeHistory");
const { getPracticeReport } = require("./apis/getPracticeReport");

wx.modelContext.registerAPI("drawQuestion", drawQuestion);
wx.modelContext.registerAPI("getPracticeHistory", getPracticeHistory);
wx.modelContext.registerAPI("getPracticeReport", getPracticeReport);
