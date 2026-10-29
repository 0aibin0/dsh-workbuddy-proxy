#!/usr/bin/env node
/**
 * 独立运行反代（不依赖 DSH 宿主）。
 *
 *   node bin/proxy.js --port 14577 --region cn
 *
 * 典型用法：把 DSH 的 provider 路由指向 http://127.0.0.1:14577/v1；
 * 或者拿 curl 直接打这台反代，验证清洗规则对不对。
 */
import process from "node:process";
import { startProxy } from "../lib/server.js";
import { dshHome } from "../lib/credentials.js";

function parseArgs(argv) {
  const out = { host: "127.0.0.1", port: 14577, region: undefined, home: dshHome() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host" && argv[i + 1] !== undefined) out.host = argv[++i];
    else if (arg === "--port" && argv[i + 1] !== undefined) out.port = Number(argv[++i]);
    else if (arg === "--region" && argv[i + 1] !== undefined) out.region = argv[++i];
    else if (arg === "--home" && argv[i + 1] !== undefined) out.home = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log("usage: node bin/proxy.js [--host 127.0.0.1] [--port 14577] [--region cn] [--home <dsh home>]");
  process.exit(0);
}

const started = await startProxy(options);
console.log(`[dsh-workbuddy-proxy] base url: ${started.baseUrl}/v1`);
console.log(`[dsh-workbuddy-proxy] health  : ${started.baseUrl}/healthz`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void started.close().then(() => process.exit(0));
  });
}
