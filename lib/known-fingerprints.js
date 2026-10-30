/**
 * 已知闸门词条（单一事实来源）。
 *
 * 数据源：`lib/known-fingerprints.json`。
 * `bin/seed-fingerprints.mjs` 和 `test/sanitize.spec.mjs` 都从这里读，
 * `scripts/install-windows.ps1` 也直接读那个 JSON —— 三处不会各写一份而漂移。
 *
 * 为什么词表要放仓库里而不是只写文档：
 * 闸门是**位置无关**的精确子串匹配（见 `lib/sanitize.js` 顶部实测记录），
 * 也就是说「宿主提示词里的任何一句」都可能命中。只要漏掉一条，整轮就 400。
 * 而这些条目是可以直接改 JSON 生效的（指纹库每次请求按 mtime 重读），
 * 所以它既是安装产物，也是用户唯一需要动的旋钮。
 *
 * 为什么是**逐句**而不是整段：
 * 官方连接插件 dsh-connect-workbuddy 的实测记录写得很清楚 —— 触发形状可能是
 * 段落的**前两句**（@ 路径段实测 111 字符），宿主提示词一旦在这里被截断，
 * 整段指纹就匹配不上，闸门照样命中。所以词条粒度必须细到「截断后仍能命中」。
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("./known-fingerprints.json", import.meta.url));

/**
 * @typedef {{id: string, mode: "tag" | "remove" | "rewrite", text: string, replace?: string}} KnownFingerprint
 */

const parsed = (() => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
})();

/** @type {KnownFingerprint[]} */
export const KNOWN_FINGERPRINTS = (Array.isArray(parsed?.items) ? parsed.items : [])
  .map((item) => ({
    id: typeof item?.id === "string" ? item.id : "",
    mode: item?.mode === "remove" ? "remove" : item?.mode === "rewrite" ? "rewrite" : "tag",
    text: typeof item?.text === "string" ? item.text : "",
    replace: typeof item?.replace === "string" ? item.replace : "",
  }))
  .filter((item) => item.text.trim() !== "");

/**
 * 被本词表取代的旧 id。合并进用户已有的指纹库时，这些条目会被移除 ——
 * 否则旧的「整段」条目会先命中，把逐句改写吃掉。
 * @type {string[]}
 */
export const SUPERSEDED_IDS = Array.isArray(parsed?.supersedes) ? parsed.supersedes : [];
