/**
 * 回归测试（node:test，无外部依赖）：
 *
 *   node --test test/
 *
 * 覆盖 2026-10-30 实测出来的三个真实缺陷：
 *
 *   1. `scansOpening()` 漏了 `developer` → 自愈二分（discoverBannedLines）拿到的是
 *      **原始** body，developer 角色从未被 normalizeRoles 改写过，于是被判成
 *      「不扫描」→ 唯一承载系统提示词的那条消息被整条跳过 → 二分永远在空集里找。
 *      DSH 实际只发 developer + user 两条消息，所以这一条就是「四档全灭且自愈
 *      救不回来」的直接原因。
 *
 *   2. 闸门是**位置无关**的精确子串匹配（官方连接插件 dsh-connect-workbuddy 的
 *      实测词表 CHANNEL_GATE_PHRASES 明确写着 "matched ANYWHERE"），而本插件原先
 *      按「只比开头」设计 —— neutral-head 档形同虚设。
 *
 *   3. 指纹库缺了 DSH 宿主的身份句 "You are an AI agent powered by DeepSeek Harness"，
 *      而它单独发就是 11128（裸打上游实测）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildAttempts, sanitizeBody, scansOpening } from "../lib/sanitize.js";
import { containsFingerprint, tagFingerprints } from "../lib/fingerprints.js";
import { KNOWN_FINGERPRINTS } from "../lib/known-fingerprints.js";

const IDENTITY = "You are an AI agent powered by DeepSeek Harness.";
const IDENTITY_PHRASE = "You are an AI agent powered by DeepSeek Harness";

test("scansOpening 覆盖 developer 角色（自愈二分的盲区）", () => {
  assert.equal(scansOpening("system"), true);
  assert.equal(scansOpening("assistant"), true);
  assert.equal(scansOpening("developer"), true, "developer 必须算被扫描的角色");
  assert.equal(scansOpening("user"), false);
  assert.equal(scansOpening("tool"), false);
});

test("developer 角色被统一改写成 system", () => {
  const body = {
    model: "m",
    messages: [{ role: "developer", content: IDENTITY }, { role: "user", content: "hi" }],
  };
  const clean = sanitizeBody(structuredClone(body), { fingerprints: KNOWN_FINGERPRINTS });
  assert.equal(clean.messages[0].role, "system");
  assert.equal(clean.messages[1].role, "user");
});

test("身份句在 developer 消息里也被清洗掉", () => {
  const body = {
    model: "m",
    messages: [{ role: "developer", content: IDENTITY }, { role: "user", content: "hi" }],
  };
  const clean = sanitizeBody(structuredClone(body), { fingerprints: KNOWN_FINGERPRINTS });
  assert.equal(containsFingerprint(clean.messages[0].content, IDENTITY_PHRASE), false);
});

test("rewrite 模式整段换成另一套措辞", () => {
  const out = tagFingerprints(IDENTITY, [
    {
      text: IDENTITY_PHRASE,
      mode: "rewrite",
      replace: "You are an AI agent running inside DeepSeek Harness",
    },
  ]);
  assert.equal(out.text, "You are an AI agent running inside DeepSeek Harness.");
});

test("rewrite 的 replace 为空时降级为 tag，不会留下未清洗的窗口", () => {
  const out = tagFingerprints(IDENTITY, [{ text: IDENTITY_PHRASE, mode: "rewrite", replace: "" }]);
  assert.equal(containsFingerprint(out.text, IDENTITY_PHRASE), false);
});

test("tag 模式在句中打断，而不是句首加前缀", () => {
  const out = tagFingerprints(IDENTITY, [{ text: IDENTITY_PHRASE, mode: "tag" }]);
  assert.equal(out.text.startsWith(IDENTITY), false);
  assert.equal(containsFingerprint(out.text, IDENTITY_PHRASE), false);
});

test("@ 路径段：打标落在两句之间，断掉 111 字符的触发形状", () => {
  // 实测：这一段单独一句是 200，前两句凑齐才 11128。
  const paragraph =
    "Tokens prefixed with @ are paths the user explicitly referenced. " +
    "Relative paths resolve from the workspace root; " +
    "absolute paths identify files or directories on the host.";
  const trigger =
    "Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root;";
  assert.equal(containsFingerprint(paragraph, trigger), true, "前置条件：原文本确实含触发形状");
  const out = tagFingerprints(paragraph, KNOWN_FINGERPRINTS);
  assert.equal(out.text.includes(trigger), false, "打标后触发形状必须被打断");
});

test("四档重试梯每一档都把 developer 归一成 system", () => {
  const body = {
    model: "m",
    messages: [{ role: "developer", content: IDENTITY }, { role: "user", content: "hi" }],
  };
  const attempts = buildAttempts(body, { fingerprints: KNOWN_FINGERPRINTS });
  assert.equal(attempts.length, 4);
  for (const attempt of attempts) {
    assert.equal(attempt.body.messages[0].role, "system");
    assert.equal(containsFingerprint(attempt.body.messages[0].content, IDENTITY_PHRASE), false);
  }
});

test("已知词条逐条都能被清洗层断掉", () => {
  assert.ok(KNOWN_FINGERPRINTS.length > 0, "词表不能为空");
  for (const item of KNOWN_FINGERPRINTS) {
    const out = tagFingerprints(`${item.text}.`, KNOWN_FINGERPRINTS);
    assert.equal(
      containsFingerprint(out.text, item.text),
      false,
      `未清洗干净: ${item.id} -> ${out.text.slice(0, 80)}`,
    );
  }
});

test("词表包含宿主的身份句（这是实测的硬闸门）", () => {
  const hit = KNOWN_FINGERPRINTS.find((item) => item.text === IDENTITY_PHRASE);
  assert.ok(hit, "词表必须包含身份句");
  assert.ok(["tag", "remove", "rewrite"].includes(hit.mode));
});
