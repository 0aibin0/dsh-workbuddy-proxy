/**
 * DSH 插件入口：把反代服务跑在宿主进程里。
 *
 * 插件本身不碰模型路由——它只提供一台本机 HTTP 服务：
 *   http://127.0.0.1:<port>/v1  （OpenAI 兼容）
 * 然后由 `llm-pi-ai` 的 provider 路由指向它。这样任何客户端（DSH、curl、
 * 其它工具）都能用同一套清洗规则访问 WorkBuddy。
 */
import { startProxy } from "./server.js";

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
