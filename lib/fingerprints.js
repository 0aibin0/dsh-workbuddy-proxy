/**
 * 指纹句处理。
 *
 * 2026-10-29 实测的网关行为（CN 渠道，glm-5.3-flash，账号 33438982…）：
 *
 *   1. 网关扫的是 **system / assistant 消息**里的文本，工具描述（tools[]）不扫。
 *   2. 命中的是**精确子串**，但匹配前会把空白**归一化**：句号后加两个空格、
 *      换行、全角空格都照样命中。
 *   3. 插入不可见字符**无效**：U+200B / U+200C / U+200D / U+2060 / U+FEFF /
 *      U+00AD 全部照旧命中——网关把这类字符归一化掉了。
 *   4. 改一个**字母**立刻放行；删掉整句也放行。
 *
 * 也就是说：官方连接插件赖以生存的「零宽扰动」这一档，对今天这条新词条已经
 * 完全失效（它 2026-10-21 实测有效，网关后来把匹配改严了）。
 *
 * 所以本模块的策略是：**给命中的句子加一个前缀标记**（默认 "Note: "）。
 * 这既打散了字节级指纹，又把原句完整保留给模型看——比删句更不伤语义。
 */
import fs from "node:fs";
import path from "node:path";

/** 逃���正则元字符。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把一句指纹编译成正则：空白段变成 `\s+`（网关按空白归一化后的等价形式）。
 */
export function fingerprintPattern(text) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized === "") return undefined;
  // 先转义再把「空格」换成 \s+：网关匹配前会归一化空白，所以等价形式要按空白匹配。
  const escaped = escapeRegExp(normalized).split(" ").join("\\s+");
  return new RegExp(escaped, "g");
}

/** 句子里是否含这条指纹（忽略空白差异）。 */
export function containsFingerprint(text, fingerprint) {
  const pattern = fingerprintPattern(fingerprint);
  if (pattern === undefined) return false;
  pattern.lastIndex = 0;
  return pattern.test(String(text ?? ""));
}

/** 指纹既可以是纯字符串，也可以是 {text, mode} 记录；统一成记录。 */
function toRecord(fingerprint) {
  if (typeof fingerprint === "string") return { text: fingerprint, mode: "tag" };
  const text = typeof fingerprint?.text === "string" ? fingerprint.text : "";
  return { text, mode: fingerprint?.mode === "remove" ? "remove" : "tag" };
}

/**
 * 给命中的指纹句打标。
 *
 * 关键点：标记必须插在**命中片段内部**。网关做的是子串匹配，所以只在句首加
 * 一个 "Note: " 是没用的——那串字仍然原样连续存在。加在句中（第一个句号后）
 * 才真的把字节级的指纹打散，而模型读到的内容基本不变。
 *
 * @returns {{text: string, hits: string[]}}
 */
export function tagFingerprints(text, fingerprints, tag = " (note)") {
  let out = String(text ?? "");
  const hits = [];
  for (const raw of fingerprints ?? []) {
    const fingerprint = toRecord(raw);
    const pattern = fingerprintPattern(fingerprint.text);
    if (pattern === undefined) continue;
    pattern.lastIndex = 0;
    if (!pattern.test(out)) continue;
    hits.push(fingerprint.text);
    pattern.lastIndex = 0;
    // 从后往前替换，避免前面的插入改变后面的偏移
    const matches = [...out.matchAll(pattern)];
    for (const match of matches.reverse()) {
      const at = match.index ?? 0;
      const span = match[0];
      if (fingerprint.mode === "remove") {
        out = `${out.slice(0, at)}${out.slice(at + span.length)}`;
        continue;
      }
      // 插入点：第一个句号之后，否则第一个空格处
      const dot = span.indexOf(". ");
      const space = span.indexOf(" ");
      const offset = dot >= 0 ? dot + 1 : (space >= 0 ? space : 0);
      out = `${out.slice(0, at + offset)}${tag}${out.slice(at + offset)}`;
    }
  }
  return { text: out, hits };
}

/** 指纹库在 DSH_HOME 里的位置（用户可直接编辑，随时加词条）。 */
export function fingerprintPath(home) {
  return path.join(home, "workbuddy-proxy-fingerprints.json");
}

/**
 * 读指纹库。
 *
 * 文件格式：`{ "items": [ { "id": "...", "text": "...", "mode": "tag" | "remove" } ] }`
 * 读不到就返回空数组（反代照常工作，只是没有指纹知识）。
 */
export function loadFingerprints(home) {
  const file = fingerprintPath(home);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items
      .map((item) => ({
        id: typeof item?.id === "string" ? item.id : "",
        text: typeof item?.text === "string" ? item.text : "",
        mode: item?.mode === "remove" ? "remove" : "tag",
      }))
      .filter((item) => item.text.trim() !== "");
  } catch {
    return [];
  }
}

/** 追加一条指纹并落盘（去重）。 */
export function rememberFingerprint(home, text, id) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized === "") return loadFingerprints(home);
  const items = loadFingerprints(home);
  if (items.some((item) => item.text === normalized)) return items;
  items.push({
    id: id ?? `fp-${Date.now().toString(36)}`,
    text: normalized,
    mode: "tag",
  });
  try {
    fs.writeFileSync(fingerprintPath(home), `${JSON.stringify({ version: 1, items }, null, 2)}\n`, "utf8");
  } catch {
    /* 落盘失败只影响「下次也记得」，不影响本次 */
  }
  return items;
}
