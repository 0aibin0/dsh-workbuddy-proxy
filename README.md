# dsh-workbuddy-proxy

在 **DSH** 与 **WorkBuddy 网关** 之间插一台本机反代，把请求清洗一遍再发出去，绕开上游的「渠道校验」（`11128 / channel_reject`）。

```
DSH  →  http://127.0.0.1:14577/v1  →  dsh-workbuddy-proxy  →  https://copilot.tencent.com/v2/chat/completions
```

## 为什么需要它

WorkBuddy 网关会扫描每一条 `system` / `assistant` 消息的**内容**，命中它内部的「渠道」词表就返回 `11128`。2026-10-29/30 实测：被禁的既不是账号也不是积分，而是 **DSH 宿主系统提示词里的句子**。

网关的匹配是「空白归一化 + 字母逐字」的**精确子串**，所以：

- 插零宽字符（U+200B 等六种）、句号后加双空格、换行 → **都无效**；
- 改一个字母、或删掉整句 → **立刻放行**；
- 只是在句**前**加个 `Note: ` → **无效**（子串还在）。

本插件因此做三件事：剥壳、把命中句**在句中打断**或**整段改写**、撞到新词条时**自动二分测出来并入库**。

### 闸门是「位置无关」的（2026-10-30 实测）

网关匹配的是**内容里的任何一处**，不只是消息开头。官方连接插件 `dsh-connect-workbuddy` 的实测词表
（`lib/host-heartbeat-*.js` 的 `CHANNEL_GATE_PHRASES`）里明确写着：

> `from` strings are matched **ANYWHERE, not just at an opening**, because the measured rule is position-independent.

所以「在句首垫一行中性头」这类挡法**对身份句无效** —— 原句还在句中。

### 实测到的两条硬闸门

裸打上游（`copilot.tencent.com`，不走本反代）逐条测：

| 内容 | 结果 |
|---|---|
| `You are an AI agent powered by DeepSeek Harness`（宿主身份句，来自 `@deepseek-ai/dsh-system-prompt`） | **11128** |
| `Tokens prefixed with @ are paths the user explicitly referenced.` + `Relative paths resolve from the workspace root;`（**两句凑齐**，来自 `@deepseek-ai/dsh-file-reference`） | **11128** |
| 上面任何一句**单独**发 | 200 |

要点：

1. **闸门在宿主系统提示词里，不在工具调用描述里** —— 身份句才是那条最狠的。
2. 触发形状可能是**多句**：@ 路径段单独一句是 200，前两句凑齐才 11128。所以词条粒度必须细到
   「宿主把这段截断了也照样命中」，否则整段指纹匹配不上、闸门照样命中。
3. 这两条闸门来自 DSH 宿主的三个包：`@deepseek-ai/dsh-system-prompt`（身份句）、
   `@deepseek-ai/dsh-file-reference`（@ 路径段）、`@deepseek-ai/dsh-harness-dev-context`（Web GUI 段）。

### `developer` 角色

还有一类完全不同的拒绝：**只要消息里出现 `developer` 角色，网关就回 11128**，与内容无关——干净文本照样被拒：

```
{role:"developer", content:"你是一个助手。"}      -> BLOCK
{role:"system",…} + {role:"developer",…}         -> BLOCK
```

pi-ai 在工具增删时会生成 `developer` 消息，**而且 DSH 平时就是这么把系统提示词发过来的** ——
所以线上最常见的一轮实际只有两条消息：

```
{role:"developer", content:"<宿主系统提示词>"} + {role:"user", content:"…"}
```

本插件把它统一改写成 `system`（官方连接插件也是这么做的）。漏掉这一步的表现很迷惑：四档重试全灭，
而自愈二分什么也找不到——因为内容本身没问题。

> 连带修掉的一个坑：自愈二分（`discoverBannedLines`）拿的是**原始** body，里面的 `developer`
> 角色从没被改写过，于是被「只扫 system/assistant」的过滤器整条跳过 —— 二分永远在空集里找。
> 现在 `scansOpening()` 也认 `developer`，新词条才真能自愈。

## 安装

```bash
# 方式一：DSH 插件管理（推荐）—— 走 GitHub Release 的 tarball
dsh plugin --profile desktop add \
  "https://github.com/0aibin0/dsh-workbuddy-proxy/releases/latest/download/dsh-workbuddy-proxy-0.1.1.tgz"

# 方式一之二：走 Git（要能改源码就用这个）
dsh plugin --profile desktop add "github:0aibin0/dsh-workbuddy-proxy#v0.1.1"

# 方式二：直接从 Git 装（开发/本地）
git clone git@github.com:0aibin0/dsh-workbuddy-proxy.git
```

> ⚠️ **不要写裸包名** `dsh plugin --profile desktop add dsh-workbuddy-proxy`：
> 插件管理器是按包名去 **npm registry** 找的（`ERR_PNPM_FETCH_404 ... registry.npmjs.org/...`），
> 它拿不到包就读不到 `package.json` 里的 `dsh.install.tarball`，所以裸包名对没发过 npm 的包必然 404。
> 要用 tarball 就直接给上面的 URL。

插件管理器会把依赖写进 profile 的 `package.json`，并自动加进 `dsh.profile.bundles`。

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

> 不想手工接线的话：直接跑仓库根目录的 **`install.bat`**（Windows 一键安装，自动用脚本自身所在目录作为安装路径，见下文「在另一台电脑部署」）。

## 在另一台电脑部署（工作机）

### 前置条件

| 条件 | 说明 |
|---|---|
| DSH 桌面版已安装 | 反代跑在 DSH 进程内，**不需要单独装 Node** |
| `dsh-connect-workbuddy` 已装并**已登录** | 反代读它写的账号保险库 `$DSH_HOME/workbuddy-vault/`；没登录就没有凭证，转发会 401 |
| 能访问 GitHub / 公司代理放行 | release tarball 或 git clone 二选一 |

> 第 2 条是**唯一必须自己搞定**的一步：账号凭证只能在 WorkBuddy 插件里登录后才有，
> 本插件不会、也不该替你登录。反代起不来不是它的问题，`healthz` 会明说 `no-credential`。

### 两步（推荐：插件管理器）

```bash
# 1) 装进 profile（自动写 dependencies + dsh.profile.bundles）
dsh plugin --profile desktop add \
  "https://github.com/0aibin0/dsh-workbuddy-proxy/releases/latest/download/dsh-workbuddy-proxy-0.1.2.tgz"

# 2) 重启 DSH，然后在模型选择器里选带 (Proxy) 的条目
```

**剩下的接线插件自己在启动时做完**（`lib/self-register.js`，0.1.2 起）：

| 缺什么 | 插件自动补什么 | 补完之后 |
|---|---|---|
| `<profile>/cordis.patch.yml` 里没有 `workbuddyproxy` 路由 | 往 `llm-pi-ai.providers` 下写 6 个模型的路由 | 模型选择器里出现 `(Proxy)` 条目 |
| `$DSH_HOME/workbuddy-proxy-fingerprints.json` 不存在 | 用仓库词表种子（13 条，含宿主身份句） | 不会因为身份句直接被 11128 |
| 账号保险库缺失 | **不补**，只在日志里告警 | 需要你先装 `dsh-connect-workbuddy` 并登录 |

自注册的边界很明确：**只在缺失时写，已经存在就一个字都不改**（你手改过的配置不会被覆盖）。
第一次启动补完路由后需要再重启一次，`llm-pi-ai` 才会读到新 provider。

> 实测（2026-10-30）：在只有 `@deepseek-ai/dsh-base` 的干净 profile 上，
> `dsh plugin add` 之后 patch 仍是空数组 `[]`、DSH_HOME 下也没有指纹库 ——
> 也就是说旧版必须手工改 YAML 才能用。0.1.2 起这两步由插件自己完成。

### 另一条路：仓库 + 一键安装脚本

适合要改源码、或想完全手工控制的情况：

```powershell
# 1) 拿到源码（放到你想要的目录）
git clone git@github.com:0aibin0/dsh-workbuddy-proxy.git C:\tools\dsh-workbuddy-proxy
#   （或下载 zip 解压到任意目录）

# 2) 一键安装：双击 install.bat，或命令行执行
C:\tools\dsh-workbuddy-proxy\install.bat
#   可选参数：
#     install.bat -Profile desktop -Port 14577 -DshHome C:\Users\me\.dsh
#     install.bat -Vault C:\Users\other\.dsh\workbuddy-vault   ← 从已登录机器导入账号库
#       （-Vault 也可以给上一级 .dsh 目录，脚本会自动识别）

# 3) 重启 DSH（路由和插件都在启动时读）

# 4) 验证
curl http://127.0.0.1:14577/healthz
```

也可以直接调 PowerShell 脚本（BAT 内部就是调它）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\tools\dsh-workbuddy-proxy\scripts\install-windows.ps1 `
  -PluginDir C:\tools\dsh-workbuddy-proxy -Profile desktop -Port 14577
```

安装器做四件事，全部幂等：

1. 在 `<profile>/package.json` 里声明依赖（`link:` 到源码目录）+ 加进 `dsh.profile.bundles`；
2. 在 `<profile>/node_modules/` 建 junction（Windows 目录链接，不用跑 pnpm install）；
3. 在 `<profile>/cordis.patch.yml` 的 `llm-pi-ai.providers` 下插入 `workbuddyproxy` 路由；
4. 在 `$DSH_HOME/workbuddy-proxy-fingerprints.json` **合并**已知指纹（同 id 就地更新、新 id 追加、
   你自己加的条目保留、仓库取代掉的旧 id 移除）。

同时会检查账号保险库是否存在，缺了就提示「去登录 WorkBuddy 插件，或从已登录的机器复制 `workbuddy-vault` 目录」。

> 第 4 步是**合并**而不是「文件存在就跳过」：闸门词表会变，已装过的机器也必须能拿到新词条，
> 否则一次新闸门就能让整轮 400。

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
| `healthz` 返回 `no-credential` | WorkBuddy 插件**装了但没登录**——它只在登录后才写 `workbuddy-vault`，空目录等于没凭证 | 在本机登录一次；或从已登录机器导入：`install.bat -Vault C:\Users\other\.dsh\workbuddy-vault`（也可以给上一级 `.dsh` 目录） |
| 中文脚本乱码 | 脚本必须存成 **UTF-8 带 BOM**（仓库里的已带） |

## 快速开始

```bash
# 1) 写入已知指纹（词表在 lib/known-fingerprints.json）
node bin/seed-fingerprints.mjs

# 2) 独立跑反代（不依赖 DSH）
node bin/proxy.js --port 14577

# 3) 健康检查
curl http://127.0.0.1:14577/healthz

# 4) 探针：直连网关 vs 走反代
node test/probe.mjs --model glm-5.3-flash

# 5) 回归测试（不需要账号，纯本地）
npm test
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
  "version": 2,
  "items": [
    { "id": "dsh-host-identity", "mode": "rewrite",
      "text": "You are an AI agent powered by DeepSeek Harness",
      "replace": "You are an AI agent running inside DeepSeek Harness" },
    { "id": "dsh-file-reference-1", "mode": "rewrite",
      "text": "Tokens prefixed with @ are paths the user explicitly referenced.",
      "replace": "Paths that begin with @ are the ones the user explicitly referenced." }
  ]
}
```

- `mode: "tag"` → 在句中插 ` (note)` 打断精确子串（默认）
- `mode: "remove"` → 整句删除
- `mode: "rewrite"` → 整段换成 `replace` 给的另一套措辞（字节变了 = 子串匹配失效；语义还在 = 不像删句那样伤上下文）。`replace` 为空时自动降级成 `tag`

仓库里的已知词表在 **`lib/known-fingerprints.json`（单一事实来源）**，`bin/seed-fingerprints.mjs`、
`scripts/install-windows.ps1` 和 `test/sanitize.spec.mjs` 都读它，不会各写一份而漂移。

可以随时手改。**指纹库每次请求按 mtime 重读磁盘** —— 改完立刻生效，**不用重启 DSH**，
这是线上被拒时最快的止血旋钮（加一条 rewrite 或 tag 即可）。

撞到新词条时，反代会**运行时自愈**：用同一请求文本做行级二分（≤`maxProbes` 次探测）找出被禁句，写进本文件并重发。

> 词条要**逐句**写，不要写整段：触发形状可能是段落的前两句，宿主把这段截断后整段指纹就匹配不上。

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

## 开发

```bash
npm test        # 回归测试（node:test，无外部依赖，不需要账号）
npm run check  # 语法检查
```

改闸门规则时只改 `lib/known-fingerprints.json`（**单一事实来源**），不要在 `bin/` 或 `scripts/` 里另写一份：
`bin/seed-fingerprints.mjs` 与 `test/sanitize.spec.mjs` 读它，`scripts/install-windows.ps1` 也直接读那个 JSON。

`test/sanitize.spec.mjs` 锁住了 2026-10-30 实测出来的三个缺陷：

1. `scansOpening()` 必须覆盖 `developer` —— 否则自愈二分在空集里找，新闸条来了也救不回来；
2. 闸门是**位置无关**的 —— neutral-head 档挡不住宿主身份句；
3. 词表必须包含宿主身份句，且**逐句**粒度能覆盖被截断的触发形状（整段指纹匹配不上截断段）。

## 许可

MIT
