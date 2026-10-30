/**
 * DSH 插件入口：把反代服务跑在宿主进程里。
 *
 * 插件对外只暴露一台本机 HTTP 服务：
 *   http://127.0.0.1:<port>/v1  （OpenAI 兼容）
 * 模型路由由 `llm-pi-ai` 的 provider 指向它。
 *
 * 启动时会跑一次自注册（lib/self-register.js），把「装完之后还缺的那两步」
 * 补上：profile 的 provider 路由、$DSH_HOME 的指纹库。缺什么补什么，
 * 已经存在就一字不改 —— 这样在另一台电脑上 `dsh plugin add` 之后
 * 重启一次就能用，不用再手工改 YAML。
 */
import { startProxy } from "./server.js";
import { selfRegister } from "./self-register.js";

export const name = "dsh-workbuddy-proxy";
export const inject = [];

export function apply(ctx, config = {}) {
  const options = {
    host: typeof config.host === "string" && config.host !== "" ? config.host : "127.0.0.1",
    port: Number.isFinite(Number(config.port)) ? Number(config.port) : 14577,
    sharedSecret: typeof config.sharedSecret === "string" ? config.sharedSecret : "",
    region: typeof config.region === "string" && config.region !== "" ? config.region : undefined,
    logger: {
      log: (...args) => ctx.logger?.info?.(...args) ?? console.log(...args),
      warn: (...args) => ctx.logger?.warn?.(...args) ?? console.warn(...args),
      error: (...args) => ctx.logger?.error?.(...args) ?? console.error(...args),
    },
  };

  // 自注册先跑，且绝不因为它的失败影响反代本身
  try {
    const report = selfRegister({ port: options.port, logger: options.logger });
    if (report.fingerprints?.reason?.startsWith("write_failed")) {
      options.logger.warn(`[dsh-workbuddy-proxy] 指纹库写入失败：${report.fingerprints.reason}`);
    }
    if (report.route?.reason?.startsWith("write_failed")) {
      options.logger.warn(`[dsh-workbuddy-proxy] provider 路由写入失败：${report.route.reason}`);
    }
    if (report.route?.reason === "profile_dir_unknown") {
      options.logger.log?.(
        "[dsh-workbuddy-proxy] 未能自动识别 profile 目录 —— 如果模型选择器里没有 (Proxy) 条目，" +
          "请手工把 provider 路由加进 <profile>/cordis.patch.yml（见 README）。",
      );
    }
  } catch (error) {
    options.logger.warn(`[dsh-workbuddy-proxy] 自注册跳过：${String(error)}`);
  }

  let handle;
  const ready = startProxy(options)
    .then((started) => {
      handle = started;
      ctx.logger?.info?.(`[dsh-workbuddy-proxy] ${started.baseUrl}/v1`);
      // 让 llm-pi-ai 的 apiKeyEnv 能解析到（凭证库优先，其次进程环境）
      if (process.env.WORKBUDDY_PROXY_KEY === undefined) {
        process.env.WORKBUDDY_PROXY_KEY = "workbuddy-proxy-local";
      }
      return started;
    })
    .catch((error) => {
      // 端口被占用通常是「另一个实例已经在服务它」（例如同时开了桌面版和 CLI），
      // 这时不该把宿主带崩：路由指到那个端口依然能用。
      ctx.logger?.warn?.(`[dsh-workbuddy-proxy] 反代未在本进程启动：${String(error)}`);
      return undefined;
    });

  const dispose = async () => {
    await ready.catch(() => undefined);
    await handle?.close?.();
  };
  ctx.on?.("dispose", dispose);
  return dispose;
}

const plugin = { name, inject, apply };
export default plugin;
export { startProxy } from "./server.js";
export { DEFAULT_MODELS } from "./server.js";
export { selfRegister, ensureProviderRoute, ensureFingerprints, vaultStatus, detectProfileDir } from "./self-register.js";
