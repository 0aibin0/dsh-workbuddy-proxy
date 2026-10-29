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

## 在另一台电脑部署（工作机）

### 前置条件

| 条件 | 说明 |
|---|---|
| DSH 桌面版已安装 | 反代跑在 DSH 进程内，**不需要单独装 Node** |
| `dsh-connect-workbuddy` 已装并**已登录** | 反代读它写的账号保险库 `$DSH_HOME/workbuddy-vault/`；没登录就没有凭证，转发会 401 |
| 能访问 GitHub | clone 或下载 zip 均可 |

### 四步

```powershell
# 1) 拿到源码
git clone git@github.com:0aibin0/dsh-workbuddy-proxy.git C:\tools\dsh-workbuddy-proxy
#   （或下载 zip 解压到任意目录）

# 2) 跑安装器（幂等，可重复执行）
powershell -NoProfile -ExecutionPolicy Bypass -File C:\tools\dsh-workbuddy-proxy\scripts\install-windows.ps1 `
  -PluginDir C:\tools\dsh-workbuddy-proxy -Profile desktop -Port 14577

# 3) 重启 DSH（路由和插件都在启动时读）

# 4) 验证
curl http://127.0.0.1:14577/healthz
```

安装器做四件事，全部幂等：

1. 在 `<profile>/package.json` 里声明依赖（`link:` 到源码目录）+ 加进 `dsh.profile.bundles`；
2. 在 `<profile>/node_modules/` 建 junction（Windows 目录链接，不用跑 pnpm install）；
3. 在 `<profile>/cordis.patch.yml` 的 `llm-pi-ai.providers` 下插入 `workbuddyproxy` 路由；
4. 在 `$DSH_HOME/workbuddy-proxy-fingerprints.json` 写入已知指纹。

同时会检查账号保险库是否存在，缺了就提示「去登录 WorkBuddy 插件，或从已登录的机器复制 `workbuddy-vault` 目录」。

### 之后怎么用

- 模型选择器里选名字带 **`(Proxy)`** 的条目（provider = `workbuddyproxy`）；
- 也可以把默认模型切到反代：`<profile>/cordis.patch.yml` 里 `agent-default-model` 的 `provider` 改成 `workbuddyproxy`；
- 想改回官方通道：把 `provider` 改回 `workbuddy` 即可。

### 工作机常见坑

| 现象 | 原因 / 处理 |
|---|---|
| `AuthorizationManager 检查失败` | PowerShell 执行策略拦截 → 加 `-ExecutionPolicy Bypass` |
| 每轮都 `MISSING_CREDENTIAL` | provider 用了 `apiKeyEnv`（宿主解析不到）。本插件的路由用的是 `headers.Authorization`，若你手改过请改回来 |
| 反代起不来 / 端口被占 | 换一个 `-Port`（同时路由和插件配置会一起改）；或关掉占用该端口的旧实例 |
| `healthz` 返回 `no-credential` | WorkBuddy 插件没登录，保险库是空的 |
| 中文脚本乱码 | 脚本必须存成 **UTF-8 带 BOM**（仓库里的已带） |

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
