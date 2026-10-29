/**
 * 上游网关协议（照抄官方连接插件实测出的契约，2026-10-29 核对）。
 *
 *   CN   chat: https://copilot.tencent.com        billing: https://www.codebuddy.cn
 *   全球 chat: https://www.workbuddy.ai           billing: 同 host
 *
 *   POST {chatBase}/v2/chat/completions
 *   头：Authorization: Bearer <accessToken>
 *       User-Agent: CLI/2.63.2 CodeBuddy/2.63.2
 *       X-Product: SaaS
 *       X-User-Id / X-No-User-Id
 *       X-Enterprise-Id / X-No-Enterprise-Id
 *       X-Domain / X-No-Department-Info
 *       X-Conversation-ID / X-Conversation-Request-ID / X-Conversation-Message-ID
 *       Origin / Referer = billing base
 *
 *   Token 刷新：POST {chatBase}/v2/plugin/auth/token/refresh
 *       头：X-Refresh-Token, X-Auth-Refresh-Source: workbuddy
 *       返回 envelope { code: 0, data: { accessToken, refreshToken?, expiresIn?, domain? } }
 */
import { randomUUID } from "node:crypto";
import { persistRefreshed } from "./credentials.js";

const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";

export function regionOf(domain) {
  const lowered = String(domain ?? "").trim().toLowerCase();
  if (lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai")) return "global";
  if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "global";
  return "cn";
}

export function chatBase(domain) {
  if (regionOf(domain) !== "global") return CN_CHAT_BASE;
  const lowered = String(domain ?? "").trim().toLowerCase();
  return lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")
    ? "https://www.codebuddy.ai"
    : GLOBAL_BASE;
}

export function billingBase(domain) {
  return regionOf(domain) === "global" ? chatBase(domain) : CN_BILLING_BASE;
}

function commonHeaders(credential) {
  const billing = billingBase(credential.domain);
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: billing,
    Referer: `${billing}/`,
    "User-Agent": CLIENT_UA,
  };
}

export function chatHeaders(credential) {
  return {
    ...commonHeaders(credential),
    "Content-Type": "application/json",
    ...(credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid }),
    ...(credential.enterpriseId === undefined || credential.enterpriseId === ""
      ? { "X-No-Enterprise-Id": "1" }
      : { "X-Enterprise-Id": credential.enterpriseId }),
    ...(credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain }),
    "X-Product": "SaaS",
    "X-Conversation-ID": randomUUID(),
    "X-Conversation-Request-ID": randomUUID(),
    "X-Conversation-Message-ID": randomUUID(),
  };
}

/** 刷新 token。返回新的凭证（并写回保险库）。 */
export async function refreshCredential(credential, home) {
  if (credential.refreshToken === "") throw new Error("workbuddy: no refreshToken in the vault record");
  const response = await fetch(`${chatBase(credential.domain)}/v2/plugin/auth/token/refresh`, {
    method: "POST",
    headers: {
      ...commonHeaders(credential),
      "X-Refresh-Token": credential.refreshToken,
      "X-Auth-Refresh-Source": "workbuddy",
      ...(credential.enterpriseId === undefined || credential.enterpriseId === ""
        ? {}
        : { "X-Enterprise-Id": credential.enterpriseId }),
    },
    signal: AbortSignal.timeout(30000),
  });
  const envelope = await response.json().catch(() => undefined);
  if (!response.ok || envelope?.code !== 0) {
    throw new Error(`workbuddy: token refresh failed (http ${response.status}): ${JSON.stringify(envelope).slice(0, 200)}`);
  }
  const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
  const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
  if (accessToken === "") throw new Error("workbuddy: token refresh returned no accessToken; sign in again in the WorkBuddy app");
  const outcome = { accessToken };
  if (typeof data.refreshToken === "string" && data.refreshToken !== "") outcome.refreshToken = data.refreshToken;
  if (typeof data.expiresIn === "number" && data.expiresIn > 0) outcome.expiresInSec = data.expiresIn;
  if (typeof data.domain === "string" && data.domain !== "") outcome.domain = data.domain;
  const next = { ...credential, ...outcome, expiresAt: Math.floor(Date.now() / 1000) + (outcome.expiresInSec ?? 3600) };
  return home === undefined ? next : persistRefreshed(home, credential, outcome);
}

/**
 * 发一次聊天请求。
 *
 * @returns {{ok: boolean, status: number, text: string, response?: Response}}
 */
export async function postChat(credential, bodyJson, signal) {
  let response;
  try {
    response = await fetch(`${chatBase(credential.domain)}/v2/chat/completions`, {
      method: "POST",
      headers: {
        ...chatHeaders(credential),
        Authorization: `Bearer ${credential.accessToken}`,
      },
      body: bodyJson,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    return { ok: false, status: 0, text: `transport error: ${String(error)}` };
  }
  if (response.ok) return { ok: true, status: response.status, text: "", response };
  const text = (await response.text()).slice(0, 8192);
  return { ok: false, status: response.status, text };
}
