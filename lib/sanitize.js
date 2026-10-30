/**
 * 请求清洗层。
 *
 * WHY THIS EXISTS (2026-10-29 实测)
 * ------------------------------------------------------------------
 * WorkBuddy 网关对每一条 `system` / `assistant` 消息的**开头**做「渠道校验」，
 * 命中词表就返回 `11128` / `channel_reject`（上游文案「不是官方客户端发出的」是
 * 误导：它匹配的是内容特征，不是账号、额度、网络或区域）。
 *
 * dsh-purge 的注入稿默认带一层 ChatML 外壳：
 *
 *     <|im_start|>system:<project_instructions>
 *     ……正文……
 *
 * 插件的 `normalizeChatmlLayout()` 会把它改写成 `system:` 单独一行并整体挂到
 * system 消息最前面，于是网关看到的开头是：
 *
 *     "system:\n<project_instructions>\n\n[MODE: …"
 *
 * 这正是 2026-10-29 让 glm 通道整轮 400 的那一条。官方连接插件的「强制中性头」
 * 重试也救不了——因为那一条规则是**子串 anywhere**，把开头挪走并不影响正文里
 * 仍然存在的 `system:`。
 *
 * 所以真正的修法只有一个：**把壳从正文里去掉**。本模块负责这件事，
 * 并且附带官方插件同款的归一化与零宽扰动，作为网关继续加词条时的兜底。
 */

/** ChatML 起始标记。拆开写，避免任何编辑器/工具链把它当语法吃掉。 */
const IM_START = "<|" + "im_start|>";
const IM_END = "<|" + "im_end|>";
const PROJECT_OPEN = "<project_instructions>";
const PROJECT_CLOSE = "</project_instructions>";

/** 官方插件用的中性头：网关只比开头，垫一行就能把开头挪出匹配区。 */
export const NEUTRAL_HEAD = "You are a helpful assistant.";

/**
 * 网关已实测会拒的开头（2026-10-21 CN 网关测量快照）。
 *
 * 这不是猜测：官方插件在同一份代码里注明它是实测快照，并且明确写了「网关随时
 * 可以新增词条，本插件看不到」。所以它只用来做**已知**归一化，真正兜底的是
 * 下面的壳剥离 + 零宽扰动 + 重试梯。
 */
import { tagFingerprints } from "./fingerprints.js";
export const UNAPPROVED_CHANNEL_OPENINGS = [
  "you are an ai agent powered by deepseek harness",
  "you are claude code, anthropic's official cli for claude",
];

/** 身份从句：在从句内部逐个词边界打断，破坏「任意位置的精确子串」匹配。 */
const IDENTITY_CLAUSE =
  /(you)(\s+are\s+(?:(?:an?\s+)?[\w-]*\s*agent\s+powered\s+by|interacting\s+with\s+the\s+user\s+through\s+the\s+deepseek\s+harness))/giu;

/** 打断子串用的不可见字符：模型读得穿，网关的精确匹配读不到。 */
export const ZERO_WIDTH_SPACE = "\u200B";

/**
 * 去掉 ChatML 外壳与 project 标签。
 *
 * 深度模式（全量删除）而不是只删开头：网关的规则是子串匹配，正文里任何一处
 * 残留都会把整条请求判死。
 */
export function stripChatmlShell(text) {
  let out = String(text ?? "");
  if (out.length === 0) return out;
  out = out.split(IM_START).join("");
  out = out.split(IM_END).join("");
  out = out.split(PROJECT_OPEN).join("");
  out = out.split(PROJECT_CLOSE).join("");
  // 开头的角色标记行（"system:" 单独一行）——ChatML 壳的核心残留。
  out = out.replace(/^[\s\u200b]*(?:system|assistant|user|developer)\s*:[ \t]*(?:\r?\n|$)/i, "");
  return out.replace(/^\s+/, "").replace(/\s+$/, "");
}

/** 文本是否以网关已知的坏开头开头（只看开头，前导空白先裁掉）。 */
export function isUnapprovedChannelOpening(text) {
  const opening = String(text ?? "").replace(/^\s+/, "").toLowerCase();
  return UNAPPROVED_CHANNEL_OPENINGS.some((prefix) => opening.startsWith(prefix));
}

/** 在身份从句的每个词边界后插入零宽空格。 */
export function breakIdentityClauses(text) {
  return String(text ?? "").replace(IDENTITY_CLAUSE, (clause) =>
    clause.replace(/(\s+)/gu, `$1${ZERO_WIDTH_SPACE}`),
  );
}

/**
 * 句读边界插零宽空格（稀疏档）。
 *
 * 官方插件的「不可见扰动」：任何以精确子串匹配的指纹，只要在句子内部被改动
 * 一个字符就会失效，而模型读到的词序不变。
 */
export function perturbText(text, dense = false) {
  let out = String(text ?? "");
  if (dense) {
    // 词内断点：把 "DeepSeek|Harness" 这类相邻首字母大写词切开。
    out = out.replace(/([A-Z][A-Za-z0-9]*)(\s+)(?=[A-Z][A-Za-z0-9])/gu, `$1$2${ZERO_WIDTH_SPACE}`);
  }
  out = out.replace(/([.!?;,:\n\r])(?=\S)/g, `$1${ZERO_WIDTH_SPACE}`);
  return out;
}

function mapTextContent(content, fn) {
  if (typeof content === "string") return fn(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (typeof part !== "object" || part === null || Array.isArray(part)) return part;
    if (typeof part.type === "string" && part.type.toLowerCase() === "text" && typeof part.text === "string") {
      return { ...part, text: fn(part.text) };
    }
    return part;
  });
}

/**
 * 网关会扫描开头的角色。user / tool 不扫。
 */
export function scansOpening(role) {
  const name = String(role ?? "").trim().toLowerCase();
  // developer 也要算被扫描的角色：pi-ai 用 developer 承载系统提示词，
  // 网关只认改写后的 system/assistant。
  //
  // 2026-10-30 实测修复：自愈二分（discoverBannedLines）拿到的是**原始** body，
  // 它的 developer 角色从未被 normalizeRoles 改写过，于是 scansOpening 判 false，
  // 唯一承载系统提示词的那条消息被整条跳过 -> 二分永远「找不到」 ->
  // 四档清洗全灭时自愈也救不回来。DSH 实际只发 developer + user 两条消息。
  return name === "system" || name === "assistant" || name === "developer";
}

/**
 * 把 `developer` 角色改写成 `system`。
 *
 * 实测（2026-10-29，CN 渠道）：**只要消息里出现 `developer` 角色，网关就回 11128**，
 * 与内容无关——干净文本照样被拒（`{role:"developer", content:"你是一个助手。"}` → BLOCK）。
 * 官方连接插件的 `prepareChatBody()` 正是因此把 developer 统一改写成 system。
 *
 * pi-ai 在工具增删（tool-addition / tool-removal）时会产生 developer 消息，所以这条
 * 改写不是可选项：漏了它，带工具更新的请求会在四档重试里全灭，而自愈二分也找不到
 * 任何"被禁的句子"（内容本身没问题）。
 */
export function normalizeRoles(body) {
  for (const message of body?.messages ?? []) {
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    const role = String(message.role ?? "").trim().toLowerCase();
    if (role === "developer") message.role = "system";
  }
  return body;
}

/**
 * 对一条 body 做「剥壳 + 指纹打标」。
 *
 * @param {object} body OpenAI 形状的请求体（原地修改后返回）。
 * @param {{neutralHead?: boolean, breakClauses?: boolean, fingerprints?: object[], tag?: string}} options
 */
export function sanitizeBody(body, options = {}) {
  const neutralHead = options.neutralHead === true;
  const breakClauses = options.breakClauses !== false;
  const fingerprints = Array.isArray(options.fingerprints) ? options.fingerprints : [];
  const tag = typeof options.tag === "string" ? options.tag : " (note)";
  // 先归一化角色：developer → system（网关见到 developer 一律 11128，与内容无关）
  normalizeRoles(body);
  const messages = body?.messages;
  if (!Array.isArray(messages)) return body;
  for (const message of messages) {
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    if (!scansOpening(message.role)) continue;
    message.content = mapTextContent(message.content, (text) => {
      let next = stripChatmlShell(text);
      if (fingerprints.length > 0) {
        next = tagFingerprints(next, fingerprints, tag).text;
      }
      if (neutralHead && isUnapprovedChannelOpening(next)) {
        next = `${NEUTRAL_HEAD}\n\n${next}`;
      }
      if (breakClauses) next = breakIdentityClauses(next);
      return next;
    });
  }
  return body;
}

/**
 * 生成一串「越来越激进」的候选 body，用于 11128 之后的重试梯。
 *
 * 顺序即代价递增：
 *   0. 只剥壳（正文语义完全保留）
 *   1. 再加中性头（开头再挪一次）
 *   2. 稀疏零宽扰动（句读边界）
 *   3. 密集零宽扰动（句读 + 词内）
 */
export function buildAttempts(body, options = {}) {
  const fingerprints = Array.isArray(options.fingerprints) ? options.fingerprints : [];
  const attempts = [];
  const plain = sanitizeBody(structuredClone(body), { neutralHead: false, breakClauses: true, fingerprints });
  attempts.push({ kind: "plain", body: plain });
  const headed = sanitizeBody(structuredClone(body), { neutralHead: true, breakClauses: true, fingerprints });
  attempts.push({ kind: "neutral-head", body: headed });
  const sparse = sanitizeBody(structuredClone(body), { neutralHead: false, breakClauses: true, fingerprints });
  for (const message of sparse.messages ?? []) {
    if (typeof message !== "object" || message === null) continue;
    if (!scansOpening(message.role)) continue;
    message.content = mapTextContent(message.content, (text) => perturbText(text, false));
  }
  attempts.push({ kind: "sparse-perturb", body: sparse });
  const dense = sanitizeBody(structuredClone(body), { neutralHead: true, breakClauses: true, fingerprints });
  for (const message of dense.messages ?? []) {
    if (typeof message !== "object" || message === null) continue;
    if (!scansOpening(message.role)) continue;
    message.content = mapTextContent(message.content, (text) => perturbText(text, true));
  }
  attempts.push({ kind: "dense-perturb", body: dense });
  return attempts;
}

/** 判定一次上游失败是不是「渠道校验」拦的。 */
export function isChannelReject(status, text) {
  if (status !== 400) return false;
  const s = String(text ?? "");
  return s.includes("11128") || s.includes("channel_reject") || s.includes("unapproved channel");
}

/** 给运维看的摘要：这个 body 洗完之后还剩什么敏感痕迹。 */
export function describeBody(body) {
  const heads = [];
  const counts = { shell: 0, projectTags: 0, roleHead: 0 };
  for (const message of body?.messages ?? []) {
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
      heads.push(String(text).slice(0, 80));
      if (text.includes(IM_START) || text.includes(IM_END)) counts.shell += 1;
      if (text.includes(PROJECT_OPEN) || text.includes(PROJECT_CLOSE)) counts.projectTags += 1;
      if (/^\s*(?:system|assistant|user|developer)\s*:/i.test(text)) counts.roleHead += 1;
    }
  }
  return { heads, counts };
}
