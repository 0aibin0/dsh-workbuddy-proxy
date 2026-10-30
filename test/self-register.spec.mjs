/**
 * 自注册的回归测试（node:test，无外部依赖）。
 *
 *   node --test test/self-register.spec.mjs
 *
 * 这里锁住的是 2026-10-30 在另一台电脑上部署时踩到的两个真实断点：
 *
 *   1. `dsh plugin add` 只改 profile/package.json 的 dependencies + bundles，
 *      **不会**写 provider 路由 → 模型选择器里一个 (Proxy) 条目都没有；
 *   2. 指纹库没人种子 → 身份句闸门直接 11128。
 *
 * 还有一个「写了反而更糟」的坑：DSH 骨架模板的 cordis.patch.yml 是 `[]`，
 * 直接往后追加条目会得到两个 YAML 文档 → YAMLException → 宿主根本起不来。
 * 所以 ensureProviderRoute 必须**替换**占位行而不是追加。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectProfileDir,
  ensureFingerprints,
  ensureProviderRoute,
  vaultStatus,
} from "../lib/self-register.js";
import { KNOWN_FINGERPRINTS } from "../lib/known-fingerprints.js";

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wbp-${label}-`));
}

const SKELETON = [
  "# Your patch layer for this dsh profile, applied after every bundle layer:",
  "# a top-level YAML array of loader patch entries (id-targeted config",
  "# overrides, disables, and insert lists; `!!js` expressions allowed).",
  "[]",
  "",
].join("\n");

test("干净骨架 []：路由被写入且不留第二个 YAML 文档", () => {
  const dir = tmpdir("route1");
  fs.writeFileSync(path.join(dir, "cordis.patch.yml"), SKELETON, "utf8");

  const result = ensureProviderRoute(dir, 14577);
  assert.equal(result.changed, true);
  assert.equal(result.reason, "route_added");

  const text = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
  assert.equal(text.includes("workbuddyproxy"), true);
  // 关键：不能残留孤立的 []
  const nonComment = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  assert.equal(nonComment.includes("[]"), false, "占位行 [] 必须被替换掉");
  assert.equal(nonComment[0], "- id: llm-pi-ai");
});

test("已有 llm-pi-ai.providers：路由插到 providers 下", () => {
  const dir = tmpdir("route2");
  fs.writeFileSync(
    path.join(dir, "cordis.patch.yml"),
    [
      "- id: llm-pi-ai",
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      "  config:",
      "    providers:",
      "      xiaomi:",
      "        apiKeyEnv: XIAOMI_API_KEY",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = ensureProviderRoute(dir, 14577);
  assert.equal(result.changed, true);
  const text = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
  assert.equal(text.includes("workbuddyproxy"), true);
  assert.equal(text.includes("xiaomi:"), true, "不能动用户已有的 provider");
  // providers 下必须是同级
  const lines = text.split(/\r?\n/);
  const xiaomiIndex = lines.findIndex((line) => line.trim() === "xiaomi:");
  const wbIndex = lines.findIndex((line) => line.trim() === "workbuddyproxy:");
  assert.ok(wbIndex > xiaomiIndex);
});

test("已存在 workbuddyproxy：一个字都不改", () => {
  const dir = tmpdir("route3");
  const original = [
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    "      workbuddyproxy:",
    "        baseURL: http://127.0.0.1:9999/v1",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "cordis.patch.yml"), original, "utf8");
  const result = ensureProviderRoute(dir, 14577);
  assert.equal(result.changed, false);
  assert.equal(result.reason, "already_present");
  assert.equal(fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8"), original);
});

test("patch 文件不存在：不新建、不报错", () => {
  const dir = tmpdir("route4");
  const result = ensureProviderRoute(dir, 14577);
  assert.equal(result.changed, false);
  assert.equal(result.reason, "patch_file_missing");
});

test("profile 目录识别不出来：返回明确原因而不是乱写", () => {
  const result = ensureProviderRoute(undefined, 14577);
  assert.equal(result.changed, false);
  assert.equal(result.reason, "profile_dir_unknown");
});

test("指纹库不存在：按仓库词表种子", () => {
  const home = tmpdir("fp1");
  const result = ensureFingerprints(home);
  assert.equal(result.changed, true);
  assert.equal(result.reason, "seeded");
  assert.equal(result.items, KNOWN_FINGERPRINTS.length);

  const parsed = JSON.parse(fs.readFileSync(result.path, "utf8"));
  assert.equal(parsed.items.length, KNOWN_FINGERPRINTS.length);
  assert.ok(parsed.items.some((item) => item.id === "dsh-host-identity"));
});

test("指纹库已最新：不重写文件", () => {
  const home = tmpdir("fp2");
  ensureFingerprints(home);
  const file = path.join(home, "workbuddy-proxy-fingerprints.json");
  const before = fs.statSync(file).mtimeMs;
  const result = ensureFingerprints(home);
  assert.equal(result.changed, false);
  assert.equal(result.reason, "already_up_to_date");
  assert.equal(fs.statSync(file).mtimeMs, before, "不该重复写盘");
});

test("指纹库里的用户自加条目被保留", () => {
  const home = tmpdir("fp3");
  const file = path.join(home, "workbuddy-proxy-fingerprints.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      items: [{ id: "my-own", mode: "remove", text: "我自己发现的一句" }],
    }),
    "utf8",
  );
  ensureFingerprints(home);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(parsed.items.some((item) => item.id === "my-own"));
  assert.ok(parsed.items.some((item) => item.id === "dsh-host-identity"));
});

test("保险库缺失/存在都能如实报告", () => {
  const home = tmpdir("vault");
  assert.equal(vaultStatus(home).ok, false);

  const region = path.join(home, "workbuddy-vault", "cn");
  fs.mkdirSync(region, { recursive: true });
  fs.writeFileSync(path.join(region, "acc.json"), "{}", "utf8");
  const status = vaultStatus(home);
  assert.equal(status.ok, true);
  assert.equal(status.accounts, 1);
});

test("detectProfileDir 能从启动参数认出 profile", () => {
  const home = "C:\\Users\\me\\.dsh";
  const dir = detectProfileDir(
    { DSH_HOME: home },
    ["node", "host.js", "C:\\Users\\me\\.dsh\\profiles\\desktop", "other"],
  );
  assert.equal(path.normalize(dir), path.normalize("C:\\Users\\me\\.dsh\\profiles\\desktop"));
});

test("detectProfileDir 优先用 DSH_PROFILE_DIR", () => {
  const dir = detectProfileDir(
    { DSH_HOME: "C:\\Users\\me\\.dsh", DSH_PROFILE_DIR: "D:\\custom\\profile" },
    [],
  );
  assert.equal(path.normalize(dir), path.normalize("D:\\custom\\profile"));
});
