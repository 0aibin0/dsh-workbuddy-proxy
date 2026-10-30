/**
 * 插件自注册：把「装完之后还缺的那两步」在宿主启动时自动补上。
 *
 * 为什么需要它（2026-10-30 实测）：
 *   在干净的 DSH 上 `dsh plugin --profile <p> add <tarball>` 之后，只有
 *     profile/package.json 的 dependencies + dsh.profile.bundles 被改了。
 *   而本插件要真正可用还差两样，没人替你写：
 *     1. profile/cordis.patch.yml 里 llm-pi-ai 的 workbuddyproxy provider 路由
 *        —— 没有它，模型选择器里一个 (Proxy) 条目都不会出现；
 *     2. $DSH_HOME/workbuddy-proxy-fingerprints.json
 *        —— 没有它，身份句闸门会直接把整轮打成 11128。
 *   所以插件在宿主启动时自己补，缺什么补什么，已经存在就一字不改。
 *
 * 设计约束（重要）：
 *   - **只在自己缺失时写**。用户手改过的配置绝不能被覆盖 —— 宁可漏补，不可乱改。
 *   - 写文件失败不能把宿主带崩（只告警）。
 *   - profile 目录只由 Electron 桌面版独占管理时也能工作：我们写的是
 *     profile 自己的 cordis.patch.yml，那是用户的 patch 层，本来就该由用户/插件写。
 */
import fs from "node:fs";
import path from "node:path";
import { dshHome } from "./credentials.js";
import { fingerprintPath, loadFingerprints } from "./fingerprints.js";
import { KNOWN_FINGERPRINTS, SUPERSEDED_IDS } from "./known-fingerprints.js";

const PROVIDER_ID = "workbuddyproxy";
const PI_AI_ID = "llm-pi-ai";
const PI_AI_NAME = "@deepseek-ai/dsh-llm-pi-ai";

/** 与 DEFAULT_MODELS 对齐的 provider 路由模型清单（带 (Proxy) 后缀便于识别）。 */
const PROVIDER_MODELS = [
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash (Proxy)", maxTokens: 131072, efforts: ["low", "high", "max"] },
  { id: "glm-5.3", name: "GLM-5.3 (Proxy)", maxTokens: 64000, efforts: ["low", "high", "max"] },
  { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash (Proxy)", maxTokens: 128000, efforts: ["low", "high", "max"] },
  { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash (Proxy)", maxTokens: 128000, efforts: ["low", "medium", "high", "max"] },
  { id: "kimi-k3-1", name: "Kimi-K3 (Proxy)", maxTokens: 32000, efforts: ["low", "high"] },
  { id: "space-bunny", name: "Space-Bunny (Proxy)", maxTokens: 128000, efforts: ["low", "high", "max"] },
];

/**
 * 当前进程跑在哪个 profile 里。
 *
 * 探测顺序（按可靠性，2026-10-30 用 inspector 进真实宿主进程实测得出）：
 *
 *   1. `DSH_PROFILE_DIR` —— 若宿主明确给了，最权威；
 *   2. **`process.cwd()`** —— 实测真实宿主进程的 cwd 就是 profile 目录
 *      （`C:\Users\<u>\.dsh\profiles\desktop`），且它的 `DSH_HOME` /
 *      `DSH_PROFILE_DIR` 环境变量**都是 null**，argv 里也**没有** profile 路径
 *      （只有 `...\dsh` 和 `...\runtime\...`）。所以 cwd 才是真正可用的信号；
 *   3. argv 里形如 `<DSH_HOME>/profiles/<name>` 的路径 —— 兜底（有些启动方式会给）。
 *
 * 踩过的两个坑：
 *   - 一开始只查 argv → 真实宿主里永远识别不出来 → provider 路由写不进去，
 *     模型选择器里一个 (Proxy) 都没有（0.1.2 首发版本的问题）；
 *   - 中途把 argv 排在 DSH_PROFILE_DIR 前面 → 在「DSH_PROFILE_DIR 是旧值」的
 *     环境里会写错 profile。合成一条链以后两个问题都没了。
 */
export function detectProfileDir(env = process.env, argv = process.argv, cwd = process.cwd()) {
  const fromEnv =
    typeof env.DSH_PROFILE_DIR === "string" && env.DSH_PROFILE_DIR.trim() !== ""
      ? env.DSH_PROFILE_DIR.trim()
      : "";
  if (fromEnv !== "") return path.normalize(fromEnv);

  // cwd 本身就是 profile 目录：名字是 <DSH_HOME>/profiles/<name> 的形状
  if (typeof cwd === "string" && cwd !== "") {
    const normalized = path.normalize(cwd);
    const marker = `${path.sep}profiles${path.sep}`;
    const at = normalized.toLowerCase().lastIndexOf(marker.toLowerCase());
    if (at >= 0) {
      const rest = normalized.slice(at + marker.length);
      const name = rest.split(/[\\/]/).filter((part) => part !== "")[0];
      if (name !== undefined) return path.join(normalized.slice(0, at + marker.length), name);
    }
  }

  // 兜底：argv 里带 <DSH_HOME>/profiles/<name>
  const home = dshHome(env);
  const profilesRoot = path.join(home, "profiles");
  for (const arg of argv) {
    if (typeof arg !== "string") continue;
    const normalized = path.normalize(arg);
    if (normalized.toLowerCase().startsWith(profilesRoot.toLowerCase())) {
      const rest = normalized.slice(profilesRoot.length).replace(/^[\\/]+/, "");
      const name = rest.split(/[\\/]/)[0];
      if (name !== "") return path.join(profilesRoot, name);
    }
  }
  return undefined;
}

function escapeSingle(text) {
  return String(text).replace(/'/g, "''");
}

/**
 * 从 profile 目录反推 DSH_HOME（`<home>/profiles/<name>` 的形状）。
 *
 * 为什么需要：真实宿主进程里 `DSH_HOME` 是 **null**（实测），`dshHome()` 会落回
 * `~/.dsh`。如果用户把 DSH_HOME 设到别处（比如测试机、或 -DshHome 指定过），
 * 指纹库就会写进 `~/.dsh` 而不是真正在用的那个 home。
 */
export function homeFromProfileDir(profileDir) {
  if (typeof profileDir !== "string" || profileDir === "") return undefined;
  const normalized = path.normalize(profileDir);
  const marker = `${path.sep}profiles${path.sep}`;
  const at = normalized.toLowerCase().lastIndexOf(marker.toLowerCase());
  if (at < 0) return undefined;
  const before = normalized.slice(0, at);
  return before === "" ? undefined : before;
}

/** 解析本次运行真正该用的 DSH_HOME：优先显式，其次 profile 反推，最后默认。 */
export function resolveHome(env = process.env, profileDir) {
  const explicit = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  if (explicit !== "") return path.normalize(explicit);
  const derived = homeFromProfileDir(profileDir);
  if (derived !== undefined) return derived;
  return dshHome(env);
}

/** 生成插进 llm-pi-ai.providers 下的 YAML 片段（4 空格缩进的 provider 名开始）。 */
function providerYaml(port) {
  const base = " ".repeat(6); // providers 下的一级
  const inner = " ".repeat(8);
  const lines = [
    `${base}${PROVIDER_ID}:`,
    `${inner}api: openai-completions`,
    `${inner}baseURL: http://127.0.0.1:${port}/v1`,
    `${inner}headers:`,
    `${inner}  Authorization: Bearer workbuddy-proxy-local`,
    `${inner}models:`,
  ];
  for (const model of PROVIDER_MODELS) {
    lines.push(`${inner}  - id: ${model.id}`);
    lines.push(`${inner}    name: ${model.name}`);
    lines.push(`${inner}    input:`);
    lines.push(`${inner}      - text`);
    lines.push(`${inner}      - image`);
    lines.push(`${inner}    reasoningEfforts:`);
    for (const effort of model.efforts) lines.push(`${inner}      ${effort}: ${effort}`);
    lines.push(`${inner}    contextWindow: 1000000`);
    lines.push(`${inner}    maxTokens: ${model.maxTokens}`);
  }
  return lines;
}

/**
 * 把 workbuddyproxy 路由写进 profile 的 cordis.patch.yml。
 *
 * 只在「整个文件里没有 workbuddyproxy」时动手：一旦有了（不论谁写的、写成什么样），
 * 一律不碰。找不到 llm-pi-ai.providers 时就整块追加一个 llm-pi-ai patch 条目。
 *
 * @returns {{changed: boolean, reason: string, path?: string}}
 */
export function ensureProviderRoute(profileDir, port = 14577) {
  if (typeof profileDir !== "string" || profileDir === "") {
    return { changed: false, reason: "profile_dir_unknown" };
  }
  const patchPath = path.join(profileDir, "cordis.patch.yml");
  let text = "";
  try {
    text = fs.readFileSync(patchPath, "utf8");
  } catch {
    return { changed: false, reason: "patch_file_missing", path: patchPath };
  }
  if (text.includes(PROVIDER_ID)) {
    return { changed: false, reason: "already_present", path: patchPath };
  }

  const lines = text.split(/\r?\n/);
  // 找 `- id: llm-pi-ai` 之后的第一个 `providers:`，缩进参照它
  let piIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*-\s*id:\s*llm-pi-ai\s*$/.test(lines[i])) {
      piIndex = i;
      break;
    }
  }

  let out;
  if (piIndex >= 0) {
    let providersIndex = -1;
    for (let i = piIndex + 1; i < lines.length; i += 1) {
      if (/^\s*-\s*id:/.test(lines[i])) break; // 掉进下一个条目了
      if (/^\s*providers:\s*$/.test(lines[i])) {
        providersIndex = i;
        break;
      }
    }
    if (providersIndex < 0) {
      // 有 llm-pi-ai 但没有 providers：补一个
      const indent = (lines[piIndex].match(/^(\s*)/) ?? ["", ""])[1];
      const insert = [`${indent}  config:`, `${indent}    providers:`, ...providerYaml(port)];
      out = [...lines.slice(0, piIndex + 1), ...insert, ...lines.slice(piIndex + 1)];
    } else {
      // 插到 providers 下**最后一个子键之后**，而不是紧贴 providers 行 ——
      // 否则会把用户已有的 provider（如 xiaomi）挤到后面，改动面变大。
      const providersIndent = (lines[providersIndex].match(/^(\s*)/) ?? ["", ""])[1];
      const childIndent = `${providersIndent}  `;
      let insertAt = providersIndex + 1;
      for (let i = providersIndex + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.trim() === "") {
          // 空行：如果后面还是同级/更深的内容就继续，否则停
          const next = lines.slice(i + 1).find((candidate) => candidate.trim() !== "");
          if (next === undefined) break;
          const nextIndent = (next.match(/^(\s*)/) ?? ["", ""])[1];
          if (nextIndent.length <= providersIndent.length) break;
          continue;
        }
        const lineIndent = (line.match(/^(\s*)/) ?? ["", ""])[1];
        if (!line.startsWith(childIndent)) break; // 离开 providers 子树
        if (/^\s*-\s*id:/.test(line)) break; // 下一个 patch 条目
        if (lineIndent.length >= childIndent.length) insertAt = i + 1;
      }
      out = [...lines.slice(0, insertAt), ...providerYaml(port), ...lines.slice(insertAt)];
    }
  } else {
    // 整份 patch 里没有 llm-pi-ai：追加一个最小条目。
    //
    // 关键：patch 必须是**一个** YAML 文档（顶层就是一个数组）。骨架模板给的
    // 是 `[]` 或 `null` 这种「空数组占位」，直接往后追加会得到
    //     []
    //     - id: llm-pi-ai
    // 这是两个文档 → YAMLException: document separator is expected → 宿主起不来。
    // 实测踩过（2026-10-30）：所以遇到占位必须**替换**掉，而不是追加。
    const block = [`- id: ${PI_AI_ID}`, `  name: "${PI_AI_NAME}"`, `  config:`, `    providers:`, ...providerYaml(port)];
    const isPlaceholder = (line) => {
      const body = trimBom(line).trim();
      return body === "" || body === "[]" || body === "null" || body === "~" || body.startsWith("#");
    };
    const trimmed = lines.filter((line) => !isPlaceholder(line));
    out = [...trimmed, ...block];
  }

  try {
    fs.writeFileSync(patchPath, out.join("\n"), "utf8");
    return { changed: true, reason: "route_added", path: patchPath };
  } catch (error) {
    return { changed: false, reason: `write_failed: ${String(error)}`, path: patchPath };
  }
}

function trimBom(line) {
  return String(line).replace(/^\uFEFF/, "");
}

/**
 * 把仓库词表合并进指纹库。语义与 bin/seed-fingerprints.mjs 一致：
 * 同 id 就地更新、新 id 追加、用户自加条目保留、被取代的旧 id 移除。
 *
 * 只在**文件不存在或条目有缺**时写盘；用户已经改对的不会被覆盖。
 *
 * @returns {{changed: boolean, reason: string, items: number, path: string}}
 */
export function ensureFingerprints(home = dshHome()) {
  const file = fingerprintPath(home);
  let existing = { version: 1, items: [] };
  let existed = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) existing = parsed;
  } catch {
    existed = false;
  }

  const superseded = new Set(SUPERSEDED_IDS);
  const items = (Array.isArray(existing.items) ? existing.items : []).filter(
    (item) => !superseded.has(String(item?.id ?? "")),
  );
  const byId = new Map(items.map((item) => [String(item?.id ?? ""), item]));
  const texts = new Set(items.map((item) => String(item?.text ?? "")));

  let changed = !existed || items.length !== (existing.items?.length ?? 0);
  for (const known of KNOWN_FINGERPRINTS) {
    const entry = {
      id: known.id,
      mode: known.mode,
      text: known.text,
      ...(known.mode === "rewrite" && known.replace !== "" ? { replace: known.replace } : {}),
    };
    const current = byId.get(known.id);
    if (current !== undefined) {
      const same =
        String(current.mode) === entry.mode &&
        String(current.text) === entry.text &&
        String(current.replace ?? "") === String(entry.replace ?? "");
      if (!same) {
        Object.assign(current, entry);
        changed = true;
      }
      continue;
    }
    if (texts.has(known.text)) continue;
    items.push(entry);
    byId.set(known.id, entry);
    texts.add(known.text);
    changed = true;
  }

  if (!changed) return { changed: false, reason: "already_up_to_date", items: items.length, path: file };
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ version: 2, items }, null, 2)}\n`, "utf8");
    return { changed: true, reason: existed ? "merged" : "seeded", items: items.length, path: file };
  } catch (error) {
    return { changed: false, reason: `write_failed: ${String(error)}`, items: items.length, path: file };
  }
}

/** 账号保险库状态：没有凭证时转发必然 401，启动时就该提醒。 */
export function vaultStatus(home = dshHome()) {
  const dir = path.join(home, "workbuddy-vault");
  try {
    const regions = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    let accounts = 0;
    for (const region of regions) {
      try {
        accounts += fs
          .readdirSync(path.join(dir, region.name))
          .filter((name) => name.endsWith(".json")).length;
      } catch {
        /* 忽略 */
      }
    }
    return { ok: accounts > 0, accounts, dir };
  } catch {
    return { ok: false, accounts: 0, dir };
  }
}

/**
 * 一次性做完启动自检。任何一步失败都只告警，不影响反代本身。
 *
 * @param {{profileDir?: string, home?: string, port?: number, logger?: any}} options
 */
export function selfRegister(options = {}) {
  const port = Number.isFinite(Number(options.port)) ? Number(options.port) : 14577;
  const logger = options.logger ?? console;
  const profileDir = options.profileDir ?? detectProfileDir();
  // home 的解析顺序：显式传入 > DSH_HOME 环境变量 > 从 profile 目录反推 > ~/.dsh。
  // 真实宿主里 DSH_HOME 往往是 null（实测），这时「从 profile 反推」才是对的。
  const home = options.home ?? resolveHome(process.env, profileDir);
  const report = { route: undefined, fingerprints: undefined, vault: undefined, home, profileDir };

  report.fingerprints = ensureFingerprints(home);
  if (report.fingerprints.changed) {
    logger.log?.(
      `[dsh-workbuddy-proxy] 指纹库已${report.fingerprints.reason === "seeded" ? "写入" : "同步"}：` +
        `${report.fingerprints.items} 条 -> ${report.fingerprints.path}`,
    );
  }

  report.route = ensureProviderRoute(profileDir, port);
  if (report.route.changed) {
    logger.log?.(`[dsh-workbuddy-proxy] 已补上 provider 路由（重启 DSH 后模型选择器里会出现 (Proxy) 条目）：${report.route.path}`);
  }

  report.vault = vaultStatus(home);
  if (!report.vault.ok) {
    logger.warn?.(
      `[dsh-workbuddy-proxy] 没找到账号保险库（${report.vault.dir}）—— 反代能起，但转发会 401。` +
        `先装 dsh-connect-workbuddy 并登录一次 WorkBuddy，或把已登录机器的 workbuddy-vault 目录拷过来。`,
    );
  }
  return report;
}
