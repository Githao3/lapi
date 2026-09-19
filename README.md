# lapi · 本地个人版 API 网关

单进程、零原生依赖（Node ≥24 内置 `node:sqlite`）、个人自用的本地 API 网关：把多个上游渠道（OpenAI / Anthropic 协议）聚合到一个本地地址，按 cc-switch 语义改写请求头，并提供「捕获模式」——让 Claude Code 等本地工具先走一遍网关、留下入站+出站双份请求头留档。



## 快速开始

```bash
pnpm install
pnpm start          # 生产：单进程服务 UI + API（默认 http://127.0.0.1:8787）
pnpm dev            # 开发：后端 8787 + Vite 5173（/v1、/api 代理到后端）
pnpm build          # 构建前端（web/dist）
pnpm test           # 纯函数单测
pnpm extract-presets # 重新提取 cc-switch 渠道预设
```

- 打开控制台，在「渠道」页新建渠道（或用「预设库」一键预填），再在「预设库→UA 伪装」选一条 Claude Code 工具 UA。
- 编辑渠道弹窗里的「拉取模型」**未保存也能拉**（走 `/api/channels/fetch-models` 草稿接口）：网关按 cc-switch 的候选链请求上游 `/v1/models`（仅 404/405 才换下一个候选；兼容 `/anthropic` 等子路径与 `/v4` 版本段结尾的 base），拉回模型列表后**点选即填入** models 字段（选一个填一个，也可一键全填）——纯拉取，没有「测试」语义。
- 工具的 base_url 填 `http://127.0.0.1:8787`。本机自用（绑定 127.0.0.1）时 key 随便填，真正生效的是每个渠道里存的 key；对外提供服务时（绑定 0.0.0.0 / 公网 IP）必须填**用户 key**，见「安全硬规则」。
- 端口被占时自动顺延（8788、8789…）并写回设置。

。



## 对外端点

| 端点 | 协议 | 说明 |
| --- | --- | --- |
| `POST /v1/messages` | Anthropic | Claude Code / claude CLI 走这里 |
| `POST /v1/chat/completions` | OpenAI | |
| `POST /v1/responses` | OpenAI | 透传或自动转换（取决于命中渠道声明的上游格式） |
| `GET /v1/models`（别名 `GET /models`） | 兼容形态 | 内容=**全部启用渠道**已声明模型名（含映射别名）的去重并集——跨格式转换下任一模型从任一端点可达，故不按渠道协议过滤；条目为 OpenAI/Anthropic 字段超集（`id`/`object`/`owned_by` + `type`/`display_name`），严格解析器两者通吃 |

模型三级匹配：精确名（含 modelMapping 别名）→ 归一化（剥日期后缀，如 `claude-sonnet-4-5-20250829` → `claude-sonnet-4-5`）→ 通配（`*` 全收、`sonnet*` 前缀）。渠道里 models 字段填 `*` 表示全收。

绑定非 loopback 地址时，以上转发端点与 `/models` 都要求**用户 key**（`x-api-key` / `Authorization` / `x-goog-api-key` 任一处，`Bearer ` 前缀可有可无）；缺失或错误返回该协议格式的 401 错误体。

每个渠道在表单里用**一个「上游格式」下拉**声明上游格式（`messages` / `chat/completions` / `responses` 三选一；旧数据按 anthropic→messages、openai→chat/responses 映射，无需迁移）。客户端请求走哪条本地端点（`/v1/messages`、`/v1/chat/completions`、`/v1/responses`）都行；命中渠道的上游格式与本地请求格式**相同则直发直回**（透传）；**不同则自动转换**——请求体转成上游格式再转发，上游响应（含 SSE，逐行）转回本地格式。转换覆盖**文本对话、工具调用（tool_use ↔ tool_calls ↔ function_call 及 tool_result 往返）、图片**，并映射流式增量事件、stop_reason / usage、流内错误；截断流一律 fail-closed（绝不合成假成功）。个别长尾块（hosted web_search 桥、音频/文件等）不可转时回 400/502 并给出精确原因，绝不静默截断。`anthropic-version` 默认头跟随**渠道声明的上游格式**（messages 渠道恒注入、openai 渠道恒不带），跨格式转发也不例外。

> 跨协议转换层转译自开源 cc-switch（MIT，© 2025 Jason Young）的 Rust 转换器（`transform*.rs` / `streaming*.rs` / `codex_responses_sse.rs` / `reasoning_bridge.rs` / `json_canonical.rs` / `sse.rs`），以 JS 重新表达（`server/conversion/`）；hosted web_search 桥与全量 citations 渲染器未移植（前者 fail-closed，后者为简化版 markdown 引用）。



## 请求头改写（cc-switch 语义）

- 丢弃 hop-by-hop / CDN / 追踪头（connection、transfer-encoding、 x-forwarded-*、cf-*、traceparent 等），Host 重建为上游主机。
- 认证头按渠道 authMode 注入：`bearer` → `Authorization: Bearer <key>`；`x-api-key`；`x-goog-api-key`；`none`。
- User-Agent 可渠道级覆盖；headerOverrides 可注入额外头，，受保护名单（host/认证/content-length/accept-encoding/connection/transfer-encoding）不可覆盖。
- 缺省补 `anthropic-version: 2023-06-01`（Anthropic 路径）、`accept-encoding: identity`（统一，SSE 友好）、`content-type/accept: application/json`。
- 渠道可配多把 key（换行分隔），轮询使用。





## 捕获模式（核心功能）

「捕获」页打开全局开关后，`/v1/*`、`v1beta/*` 请求**不转发**，网关记下：

1. 入站原始头，**明文存储**（含 authorization / x-api-key / session 等——这是客户端伪装预设的原料，脱敏就拿不到真实值）；
2. 出站改写头预览（按渠道配置 mock 计算，不真发上游）；
3. body 预览（截断 4KB）。

捕获记录因此与渠道 key 同级敏感，注意 `data/` 目录权限，用完在捕获页及时清理。

并现场返回 400，错误消息内嵌以上两份头的格式化 JSON——本地工具终端里直接可读。面板「捕获」页会留档最近 200 条，可展开看全量头、一键复制、清空。捕获记录与转发日志**默认永久保存、互不挤占**（不会像早期版本那样被日常流量冲掉），统一在「日志 → 清理…」里按保留天数手动清理。



##测试场（对话页）

面板内置的对话页：选一个已配置的模型直接开聊，可设系统提示词、温度与 max_tokens；流式输出、随时停止、多轮上下文本地保存。请求走完整转发管道——渠道选择、请求头改写、跨格式转换、用量日志全部生效，所以测试场里的对话在「日志」和「概览」里同样可见。面板身份即管理员，无需用户 key；捕获模式对它不生效（它要的是回答，不是请求头）。客户端断开（点停止）会同步中止上游请求，不白烧 token。



## 心智模型

> 本机自用时工具的 key 填什么无所谓；对外提供服务时，使用者填「用户 key」调用转发，只有管理密码能登录面板查看渠道与上游 key。



##安全硬规则

两套**互相独立**的凭据，在「设置 → 访问凭据」里配置，服务器部署时也可用环境变量引导：

- **用户 key**（`gateway_token` / `LAPI_GATEWAY_TOKEN`）：发给使用者，填在工具的 key 位置。`/v1/*` 与 `/models` 用它校验；它**不能**访问 `/api`，所以拿不到渠道、上游 key 与日志。
- **管理密码**（`admin_password` / `LAPI_ADMIN_PASSWORD`）：只用于登录面板（`/api`，含渠道、上游 key、日志、设置）。`/api/config` 只回「是否已设置」，从不回传密码本身；登录带失败限速，会话在内存中、有效期 7 天、重启即失效。

绑定非 loopback 地址（0.0.0.0 / 公网 IP / 局域网 IP）时两者都必须设置，缺哪个哪类请求就被拒绝（fail-closed）；绑定 loopback（127.0.0.1）时两者都免校验，本机自用与原来完全一致。公网部署请始终用反代终结 HTTPS（见 `deploy/`）——面板与转发本身是明文 HTTP。

- 诚实边界：仅改写 HTTP 层请求头；若上游按 TLS 指纹风控（如 claude.ai 官方），换 UA 无效——那是 v2 的方向。
 预设库里对应条目已标注「暂不支持」。



##预设库

两层展示（照抄 cc-switch 结构）：

- **精选层**：人工核对过的 15–20 条知名常用渠道（Kimi、Zhipu GLM、Baidu、DeepSeek、OpenRouter、SiliconFlow、ModelScope、Moonshot 等）。
- **全部层**：从开源 cc-switch（MIT）的 `claudeProviderPresets.ts` 自动提取的约 50 条原样搬运，，标注「未逐一核实」；OAuth 类（Copilot/Codex/Grok）与协议不符的条目标「暂不支持」。

此外还有两类伪装资产，在渠道编辑里**二选一**（同时配置时客户端档案优先）：

- **UA 伪装预设**：只有一条 UA 字符串，适合轻度场景。
- **客户端档案**（整组请求头）：从一条真实捕获自动分类生成——网关管辖头（host/认证/长度类）与 `anthropic-beta` 排除；session/thread/request 类头标 `fill`（客户端自带则透传、没带才补捕获值）；其余标 `fixed`（逐字重放）。三种模式在保存前可逐条修改。适用场景：让 Claude Code 的流量走某个渠道时，整组头看起来就是 opencode/codex 在发。

> 预设数据提取自开源 cc-switch（MIT），截至 2026-08，上游地址可能失效；如失效请各渠道官网确认后自行更正。重新提取：`pnpm extract-presets`。





##存储与备份

- 运行时数据存 `data/`（`lapi.db`）：渠道、两套凭据、转发与捕获日志都在其中，上游 keys 明文存储（个人工具，与 new-api 同策略），注意目录权限（`chmod 700`）。
- **日志默认永久保存，不做自动清理**（对齐 new-api 的做法）：转发日志与捕获记录互不挤占；日志页「清理…」可按保留天数（7 天～1 年或全部）手动删除，删除前会先给出预估条数。
- 备份 = 拷贝 `data/` 目录即可；`.gitignore` 已排除数据目录。环境变量 `LAPI_DB` 可把数据库指到别处（容器里固定在 `/data/lapi.db`）。



##部署到服务器（Linux + Docker）

`deploy/` 里有 Dockerfile、docker-compose.yml、Caddyfile 与逐步说明：容器只监听宿主机回环、HTTPS 交给 Caddy、数据落在 `deploy/data`，与 Windows 本机那份只共享代码、互不影响。详见 [deploy/README.md](deploy/README.md)。



##测试

```bash
node scripts/e2e.mjs            # 端到端：本地假上游 8999，覆盖路由/认证注入/UA/SSE/failover（429 重试、5xx 耗尽、半路断流零重发）/捕获模式/双形态模型列表/双凭据鉴权
node scripts/smoke-auth.mjs     # 冒烟：纯环境变量引导（容器启动方式）下的双凭据鉴权
pnpm test                       # 纯函数：URL 归一化、头改写（含受保护名单）、三级模型匹配、凭据与会话
```

端到端全部通过即打印 `[e2e] ALL ASSERTIONS PASSED`。





## v1 明确不做

`messages` / `chat` / `responses` 三格式互转已支持**文本、工具调用、图片**（含流式增量、stop/usage/错误事件映射，见「对外端点」节）；仍不做：音频/嵌入/文件等多模态中继、hosted web_search 工具桥（遇到即 400 fail-closed）、OAuth 自动登录（Copilot/Codex/Grok）、多用户/计费/配额/Redis、TLS 指纹伪装——预设库对应条目一律标「暂不支持」，不装可用。
