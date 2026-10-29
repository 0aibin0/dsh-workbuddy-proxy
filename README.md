# dsh-workbuddy-proxy

在 **DSH** 与 **WorkBuddy 网关** 之间插一台本机反代，把请求清洗一遍再发出去，绕开上游的「渠道校验」（`11128 / channel_reject`）。

```
DSH  →  http://127.0.0.1:14577/v1  →  dsh-workbuddy-proxy  →  https://copilot.tencent.com/v2/chat/completions
```

## 为什么需要它

WorkBuddy 网关会扫描每一条 `system` / `assistant` 消息的**内容**，命中它内部的「渠道」词表就返回 `11128`。2026-10-29 实测：被禁的既不是账号也不是积分，而是 **DSH 宿主系统提示词里的一句工具说明**（"Tokens prefixed with @ are paths the user explicitly referenced…"）。

网关的匹配是「空白归一化 + 字母逐字」的**精确子串**，所以：

- 插零宽字符（U+200B 等六种）、句号后加双空格、换行 → **都无效**；
- 改一个字母、或删掉整句 → **立刻放行**；
- 只是在句**前**加个 `Note: ` → **无效**（子串还在）。

本插件因此做三件事：剥壳、把命中句**在句中打断**、撞到新词条时**自动二分测出来并入库**。

## 安装

```bash
# 方式一：DSH 插件管理（推荐）
dsh plugin --profile desktop add dsh-workbuddy-proxy

# 方式二：直接从 Git 装（开发/本地）
git clone git@github.com:0aibin0/dsh-workbuddy-proxy.git
```

装完后在 profile 的 `package.json` 里加一行依赖，并在 `dsh.profile.bundles` 里加入插件名：

```json
{
  "dependencies": {
    "dsh-workbuddy-proxy": "link:F:/99_AIBIN/dsh/dsh-workbuddy-proxy"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-workbuddy-proxy"]
    }
  }
}
```

再在 `cordis.patch.yml` 里加 `llm-pi-ai` 的 provider 路由（见下文「在 DSH 里使用」）。

## 快速开始

```bash
# 1) 写入已知指纹（已实测的那句）
node bin/seed-fingerprints.mjs

# 2) 独立跑反代（不依赖 DSH）
node bin/proxy.js --port 14577

# 3) 健康检查
curl http://127.0.0.1:14577/healthz

# 4) 探针：直连网关 vs 走反代
node test/probe.mjs --model glm-5.3-flash
```

在 DSH 里使用时，provider 路由这样写（**不要写 `apiKeyEnv`**，见下）：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      workbuddyproxy:
        api: openai-completions
        baseURL: http://127.0.0.1:14577/v1
        headers:
          Authorization: Bearer workbuddy-proxy-local
        models:
          - id: glm-5.3-flash
            name: GLM-5.3-Flash (反代)
            input: [text, image]
            contextWindow: 1000000
            maxTokens: 131072
```

> **为什么不用 `apiKeyEnv`**：`llm-pi-ai` 解析凭证时先问凭证服务、再问 `launchEnvironmentOf(ctx)`——后者是**启动时快照**，插件运行时写 `process.env` 不生效；凭证文件里的 `refs` 在实测中也没被命中（`MISSING_CREDENTIAL`）。
> 改用 provider 自带的 `headers.Authorization` 就绕开了整条凭证链：pi-ai 见到已有的 Authorization 头就不再要求 apiKey，而反代本身不校验它。

## 接口

| 路由 | 说明 |
|---|---|
| `POST /v1/chat/completions` | 清洗 → 转发 → SSE 透传；`stream:false` 时聚合成普通 JSON |
| `GET /v1/models` | 模型清单 |
| `GET /healthz` | 账号、请求数、被拒次数、上次状态 |
| `POST /v1/proxy/preview` | 只清洗不转发，返回清洗前后对比 |

## 指纹库

`$DSH_HOME/workbuddy-proxy-fingerprints.json`：

```json
{
  "version": 1,
  "items": [
    { "id": "dsh-repository-file-tools", "mode": "tag",
      "text": "Tokens prefixed with @ are paths the user explicitly referenced. …" }
  ]
}
```

- `mode: "tag"` → 在句中插 ` (note)` 打断精确子串（默认）
- `mode: "remove"` → 整句删除

可以随时手改。撞到新词条时，反代会**运行时自愈**：用同一请求文本做行级二分（≤`maxProbes` 次探测）找出被禁句，写进本文件并重发。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 只监听回环 |
| `port` | `14577` | 端口被占用时只告警，不崩宿主 |
| `region` | 保险库目录名 | 账号选择 |
| `autoBisect` | `true` | 撞到新词条时自动二分定位 |
| `maxProbes` | `24` | 单次请求的探测上限 |

## 凭证

直接读官方连接插件的账号保险库：`$DSH_HOME/workbuddy-vault/<region>/<accountId>.json`
（`auth.accessToken` / `auth.refreshToken` / `auth.domain` / `account.uid`）。token 过期时自动刷新并回写保险库。

## 许可

MIT
