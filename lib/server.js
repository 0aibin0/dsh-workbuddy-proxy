/**
 * 本机反代服务：OpenAI 兼容的入，WorkBuddy 网关的出，中间夹一层可控清洗。
 *
 *   POST /v1/chat/completions   清洗 → 转发 → SSE 透传
 *   GET  /v1/models             模型清单
 *   GET  /healthz               状态
 *   POST /v1/proxy/preview      只清洗不转发（排查用，返回清洗前后的对比）
 *
 * 为什么要它：上游的「渠道校验」只看 system/assistant 消息的开头与子串，任何
 * 宿主插件往系统提示词上挂的壳（dsh-purge 的 ChatML 外壳就是其中一种）都会让
 * 整轮请求 400。有了一层反代，清洗规则就变成**可改的一行代码**，而不是改完还要
 * 重启宿主、重建会话才能验证。
 */
import { createServer } from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import { dshHome, resolveCredential } from "./credentials.js";
import { postChat, refreshCredential } from "./upstream.js";
import { buildAttempts, describeBody, isChannelReject, sanitizeBody, scansOpening } from "./sanitize.js";
import { fingerprintPath, loadFingerprints, rememberFingerprint } from "./fingerprints.js";
import { findBannedLines } from "./diagnose.js";

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** 默认模型清单：与 WorkBuddy CN 目录对齐，够 DSH 的模型选择器用。 */
export const DEFAULT_MODELS = [
  { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", contextWindow: 1000000, maxTokens: 128000 },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", contextWindow: 1000000, maxTokens: 131072 },
  { id: "glm-5.3", name: "GLM-5.3", contextWindow: 1000000, maxTokens: 64000 },
  { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash", contextWindow: 1000000, maxTokens: 128000 },
  { id: "kimi-k3-1", name: "Kimi-K3", contextWindow: 1000000, maxTokens: 32000 },
  { id: "space-bunny", name: "Space-Bunny", contextWindow: 1000000, maxTokens: 128000 },
  { id: "step-5-preview", name: "Step-5-Preview", contextWindow: 1000000, maxTokens: 64000 },
  { id: "hy4-preview", name: "Hy4 preview", contextWindow: 960000, maxTokens: 64000 },
];

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function writeOpenAiError(res, status, code, message) {
  writeJson(res, status, { error: { message, type: "invalid_request_error", code } });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function hostIsLoopback(host) {
  if (typeof host !== "string") return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

/** 把上游的 SSE 聚合成一条非流式 OpenAI 响应（客户端要 stream:false 时用）。 */
async function aggregateSse(webStream, model) {
  const chunks = [];
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let role = "assistant";
  let finishReason = "stop";
  const read = webStream.getReader();
  for (;;) {
    const { done, value } = await read.read();
    if (done) break;
    chunks.push(value);
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = event?.choices?.[0];
      const delta = choice?.delta ?? choice?.message ?? {};
      if (typeof delta.role === "string") role = delta.role;
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    }
  }
  return {
    id: `chatcmpl-proxy-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role,
          content,
          ...(reasoning === "" ? {} : { reasoning_content: reasoning }),
        },
        finish_reason: finishReason,
      },
    ],
  };
}

/**
 * 启动反代。
 *
 * @param {{host?: string, port?: number, sharedSecret?: string, region?: string, models?: object[], logger?: any}} options
 */
export async function startProxy(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = Number(options.port ?? 14577);
  const sharedSecret = options.sharedSecret ?? "";
  const region = options.region;
  const models = options.models ?? DEFAULT_MODELS;
  const logger = options.logger ?? console;
  const home = options.home ?? dshHome();

  const state = { requests: 0, channelRejects: 0, lastStatus: "", startedAt: new Date().toISOString() };
  const autoBisect = options.autoBisect !== false;
  const maxProbes = Number.isFinite(Number(options.maxProbes)) ? Number(options.maxProbes) : 24;
  const tag = typeof options.tag === "string" ? options.tag : " (note)";
  /** 指纹库缓存：文件 mtime 变了就重读，用户随时可以手改。 */
  let fingerprintCache = { mtime: 0, items: loadFingerprints(home) };
  const fingerprints = () => {
    let mtime = 0;
    try {
      mtime = fs.statSync(fingerprintPath(home)).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (mtime !== fingerprintCache.mtime) {
      fingerprintCache = { mtime, items: loadFingerprints(home) };
    }
    return fingerprintCache.items;
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.error?.("[dsh-workbuddy-proxy] request failed", error);
      if (!res.headersSent) writeOpenAiError(res, 500, "internal_error", String(error));
      else res.end();
    });
  });

  async function handle(req, res) {
    if (!hostIsLoopback(req.headers.host)) {
      writeOpenAiError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
      return;
    }
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
      const credential = resolveCredential(home, region);
      writeJson(res, 200, {
        ok: true,
        upstream: credential === undefined ? "no-credential" : "workbuddy",
        region: credential?.region ?? region ?? "cn",
        account: credential?.accountId ?? "",
        models: models.length,
        ...state,
      });
      return;
    }
    if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
      writeJson(res, 200, {
        object: "list",
        data: models.map((model) => ({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: "workbuddy-proxy",
        })),
      });
      return;
    }
    if (req.method === "POST" && (url === "/v1/proxy/preview" || url === "/v1/proxy/preview/")) {
      const raw = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        writeOpenAiError(res, 400, "invalid_json", String(error));
        return;
      }
      const before = describeBody(parsed);
      const after = describeBody(sanitizeBody(structuredClone(parsed), { neutralHead: false }));
      writeJson(res, 200, { before, after });
      return;
    }
    if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
      await chatCompletions(req, res);
      return;
    }
    writeOpenAiError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
  }

  async function chatCompletions(req, res) {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch (error) {
      writeOpenAiError(res, 400, "invalid_json", String(error));
      return;
    }
    if (typeof body !== "object" || body === null || !Array.isArray(body.messages)) {
      writeOpenAiError(res, 400, "invalid_body", "body.messages must be an array");
      return;
    }
    const wantsStream = body.stream !== false;
    body.stream = true;

    let credential = resolveCredential(home, region);
    if (credential === undefined) {
      writeOpenAiError(res, 401, "not_signed_in", `no workbuddy credential under ${home}/workbuddy-vault`);
      return;
    }

    const attempts = buildAttempts(body, { fingerprints: fingerprints() });
    let lastError = "";
    for (const attempt of attempts) {
      const payload = JSON.stringify(attempt.body);
      let result = await postChat(credential, payload);
      // token 过期：刷新一次再打同一个 attempt
      if (!result.ok && result.status === 401) {
        try {
          credential = await refreshCredential(credential, home);
          result = await postChat(credential, payload);
        } catch (error) {
          lastError = String(error);
          break;
        }
      }
      if (result.ok) {
        state.requests += 1;
        state.lastStatus = `ok (${attempt.kind})`;
        await relay(res, result.response, body.model, wantsStream);
        return;
      }
      lastError = `http ${result.status}: ${result.text}`;
      if (isChannelReject(result.status, result.text)) {
        state.channelRejects += 1;
        logger.warn?.(`[dsh-workbuddy-proxy] channel gate refused the "${attempt.kind}" attempt; trying the next rung`);
        continue;
      }
      // 不是渠道校验：换姿势也没用，直接把上游的错误如实回给客户端
      res.writeHead(result.status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
      res.end(result.text);
      return;
    }

    // 所有档位都被渠道闸门拒了：自愈——把被禁的那句话当场测出来，打标后重试。
    if (autoBisect) {
      const healed = await selfHeal(body, credential, body.model);
      if (healed !== undefined) {
        const payload = JSON.stringify(healed);
        const result = await postChat(credential, payload);
        if (result.ok) {
          state.requests += 1;
          state.lastStatus = "ok (self-healed)";
          await relay(res, result.response, body.model, wantsStream);
          return;
        }
        lastError = `http ${result.status}: ${result.text}`;
      }
    }

    state.lastStatus = "channel_reject";
    writeOpenAiError(res, 400, "channel_reject", `workbuddy 渠道校验拒绝了所有清洗档位 / last: ${lastError}`);
  }

  /**
   * 自愈：二分找出被禁的句子 → 记进指纹库 → 打标后重试。
   *
   * 探测请求用的是**同一条 system 文本的片段**（加一个极短 user 消息），
   * 这样测出来的结论和真实请求同口径。
   */
  async function selfHeal(body, credential, model) {
    const probe = async (candidate) => {
      const probeBody = {
        model,
        stream: true,
        max_tokens: 8,
        messages: [
          { role: "system", content: candidate },
          { role: "user", content: "回复: 收到" },
        ],
      };
      const result = await postChat(credential, JSON.stringify(probeBody));
      if (result.ok) {
        await result.response.body?.cancel?.().catch(() => {});
        return false;
      }
      return isChannelReject(result.status, result.text);
    };

    const found = [];
    for (const message of body.messages ?? []) {
      if (typeof message !== "object" || message === null) continue;
      if (!scansOpening(message.role)) continue;
      const texts = [];
      if (typeof message.content === "string") texts.push(message.content);
      else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (typeof part === "object" && part !== null && typeof part.text === "string") texts.push(part.text);
        }
      }
      for (const text of texts) {
        const result = await findBannedLines(text, probe, { maxProbes });
        if (result.exhausted) {
          logger.warn?.("[dsh-workbuddy-proxy] self-heal probe budget exhausted; giving up for this request");
          return undefined;
        }
        for (const line of result.lines) {
          const normalized = line.replace(/\s+/g, " ").trim();
          if (normalized !== "") found.push(normalized);
        }
      }
    }
    if (found.length === 0) return undefined;
    logger.warn?.(`[dsh-workbuddy-proxy] self-heal found ${found.length} banned line(s); tagging them`);
    for (const line of found) rememberFingerprint(home, line);
    fingerprintCache = { mtime: 0, items: loadFingerprints(home) };
    const healed = sanitizeBody(structuredClone(body), {
      neutralHead: false,
      breakClauses: true,
      fingerprints: fingerprintCache.items,
      tag,
    });
    return healed;
  }

  async function relay(res, upstream, model, wantsStream) {
    const contentType = upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8";
    if (!wantsStream) {
      const aggregated = await aggregateSse(upstream.body, model);
      writeJson(res, 200, aggregated);
      return;
    }
    res.writeHead(upstream.status, {
      "cache-control": "no-store",
      "content-type": contentType,
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const reader = Readable.fromWeb(upstream.body);
    reader.pipe(res);
    reader.on("error", () => res.end());
    res.on("close", () => reader.destroy());
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const baseUrl = `http://${host}:${actualPort}`;
  logger.log?.(`[dsh-workbuddy-proxy] listening on ${baseUrl} (home=${home})`);

  return {
    baseUrl,
    port: actualPort,
    state,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
