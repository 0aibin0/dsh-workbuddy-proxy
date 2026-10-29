/**
 * 凭证读取：直接读 WorkBuddy 连接插件写在 `$DSH_HOME/workbuddy-vault/` 下的
 * 账号保险库，不重新走 OAuth。
 *
 * 保险库结构（实测）：
 *   $DSH_HOME/workbuddy-vault/cn/<accountId>.json
 *     { version, accountId, refreshedAtMs,
 *       auth: { accessToken, refreshToken, expiresAt, domain },
 *       account: { uid, nickname, uin } }
 *
 * 为什么不复用插件自己的 store：那套 store 在 DSH 进程内、带着账号池与故障转移
 * 逻辑；本反代要的是「一个能独立跑的最小转发器」，自己读盘反而更可控——插件没
 * 起来、或者用户只想单独用反代时，它照样能用。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 插件的 host 目录（`$DSH_HOME`）。 */
export function dshHome(env = process.env) {
  const configured = String(env.DSH_HOME ?? "").trim();
  if (configured !== "") return path.normalize(configured);
  return path.join(os.homedir(), ".dsh");
}

/** 保险库里的账号记录 → 反代内部使用的凭证。 */
function toCredential(record, file) {
  const auth = record?.auth ?? {};
  const account = record?.account ?? {};
  const accessToken = typeof auth.accessToken === "string" ? auth.accessToken : "";
  if (accessToken === "") return undefined;
  return {
    accountId: typeof record.accountId === "string" ? record.accountId : path.basename(file, ".json"),
    region: path.basename(path.dirname(file)),
    accessToken,
    refreshToken: typeof auth.refreshToken === "string" ? auth.refreshToken : "",
    domain: typeof auth.domain === "string" && auth.domain !== "" ? auth.domain : "www.workbuddy.cn",
    uid: typeof account.uid === "string" ? account.uid : "",
    enterpriseId: typeof auth.enterpriseId === "string" ? auth.enterpriseId : "",
    expiresAt: typeof auth.expiresAt === "number" ? auth.expiresAt : 0,
    source: file,
  };
}

/**
 * 列出保险库里的全部账号凭证。
 *
 * 目录约定与官方插件一致：`workbuddy-vault/<region>/<accountId>.json`。
 */
export function listCredentials(home = dshHome()) {
  const vault = path.join(home, "workbuddy-vault");
  const out = [];
  let regions = [];
  try {
    regions = fs.readdirSync(vault, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return out;
  }
  for (const region of regions) {
    const dir = path.join(vault, region);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    for (const name of files) {
      const file = path.join(dir, name);
      try {
        const record = JSON.parse(fs.readFileSync(file, "utf8"));
        const credential = toCredential(record, file);
        if (credential !== undefined) out.push(credential);
      } catch {
        /* 坏文件跳过：反代不该因为一个坏账号就整体起不来 */
      }
    }
  }
  return out;
}

/**
 * 选一个可用凭证。
 *
 * 优先未过期的；全过期时也返回一个，让调用方去刷新（refreshToken 还在就能救）。
 */
export function resolveCredential(home = dshHome(), region) {
  const all = listCredentials(home);
  const scoped = region === undefined ? all : all.filter((c) => c.region === region);
  const pool = scoped.length > 0 ? scoped : all;
  if (pool.length === 0) return undefined;
  const now = Math.floor(Date.now() / 1000);
  const fresh = pool.filter((c) => c.expiresAt === 0 || c.expiresAt > now + 60);
  const chosen = (fresh.length > 0 ? fresh : pool)[0];
  return chosen;
}

/** 写回刷新后的 token（保持保险库文件仍是唯一事实源）。 */
export function persistRefreshed(home, credential, outcome) {
  if (outcome?.accessToken === undefined) return credential;
  const next = { ...credential, accessToken: outcome.accessToken };
  if (typeof outcome.refreshToken === "string" && outcome.refreshToken !== "") next.refreshToken = outcome.refreshToken;
  if (typeof outcome.expiresInSec === "number" && outcome.expiresInSec > 0) {
    next.expiresAt = Math.floor(Date.now() / 1000) + outcome.expiresInSec;
  }
  try {
    const file = credential.source;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    record.auth.accessToken = next.accessToken;
    if (typeof outcome.refreshToken === "string" && outcome.refreshToken !== "") {
      record.auth.refreshToken = outcome.refreshToken;
    }
    if (typeof outcome.expiresInSec === "number" && outcome.expiresInSec > 0) {
      record.auth.expiresAt = next.expiresAt;
    }
    record.refreshedAtMs = Date.now();
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch {
    /* 写不回保险库不算失败：本次进程内仍然有效 */
  }
  return next;
}
