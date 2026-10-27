/**
 * 统一 LLM 调用封装（云函数侧，genQuestions 专用副本）。
 * 云函数是独立部署的包，不能跨目录 require，故与 analyze/llm.js 保持一致的逻辑。
 */

const https = require("https");

function callLLM(system, user, opts = {}) {
  const { json = true, temperature = 0, maxRetries = 2 } = opts;
  const apiKey = process.env.LLM_API_KEY || "";
  const baseUrl = (process.env.LLM_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
  const model = process.env.LLM_MODEL || "deepseek-chat";

  if (!apiKey) {
    return Promise.reject(new Error("LLM_API_KEY 未配置"));
  }

  const doRequest = () =>
    new Promise((resolve, reject) => {
      const body = {
        model,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      };
      if (json) body.response_format = { type: "json_object" };

      const url = new URL(baseUrl + "/chat/completions");
      const payload = JSON.stringify(body);

      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            Authorization: "Bearer " + apiKey,
          },
          timeout: 60000,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) return reject(new Error(parsed.error.message || "llm error"));
              const content =
                parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
              resolve(content);
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("llm timeout")));
      req.write(payload);
      req.end();
    });

  let chain = Promise.reject(new Error("unreachable"));
  for (let i = 0; i <= maxRetries; i++) {
    chain = chain.catch(() => doRequest());
  }
  return chain;
}

module.exports = { callLLM };
