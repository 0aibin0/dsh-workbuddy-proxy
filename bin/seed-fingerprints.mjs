/**
 * 把已实测的指纹句写进指纹库。
 *
 *   node bin/seed-fingerprints.mjs [--home <dsh home>]
 *
 * 已实测（2026-10-29，CN 渠道 glm-5.3-flash，账号 33438982…）：
 * 这句是 DSH 宿主自己的「Repository file tools」说明，网关按**精确子串**
 * 匹配它；匹配前会归一化空白，所以插零宽字符、加双空格都没用，改一个字母或
 * 删除整句才放行。
 */
import fs from "node:fs";
import process from "node:process";
import { dshHome } from "../lib/credentials.js";
import { fingerprintPath } from "../lib/fingerprints.js";

const args = process.argv.slice(2);
const home = args.includes("--home") ? args[args.indexOf("--home") + 1] : dshHome();

const KNOWN = [
  {
    id: "dsh-repository-file-tools",
    mode: "tag",
    text:
      'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.',
  },
];

const file = fingerprintPath(home);
let existing = { version: 1, items: [] };
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) existing = parsed;
} catch {
  /* 没有就新建 */
}
const known = new Set(existing.items.map((item) => item.text));
for (const item of KNOWN) {
  if (!known.has(item.text)) existing.items.push(item);
}
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
console.log(`fingerprints -> ${file} (${existing.items.length} items)`);
for (const item of existing.items) console.log(`  - ${item.id}: ${item.text.slice(0, 70)}…`);
