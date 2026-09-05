# lapi · 本地个人版 API 网关

单进程、零原生依赖（Node ≥24 内置 `node:sqlite`）、个人自用的本地 API 网关：把多个上游渠道（OpenAI / Anthropic 协议）聚合到一个本地地址，按 cc-switch 语义改写请求头，并提供「捕获模式」——让 Claude Code 等本地工具先走一遍网关、留下入站+出站双份请求头留档。



## 快速开始

```bash
pnpm install
pnpm start          # 生产：单进程服务 UI + API（默认 http://127.0.0.1:8787）
pnpm dev            # 开发：后端 8787 + Vite 5173（/v1、/api 代理到后端）
pnpm build          # 构建前端（web/dist）
pnpm test           # 纯函数单测（18 项）
pnpm extract-presets # 重新提取 cc-switch 渠道预设
```

- 打开控制台，在「渠道」页新建渠道（或用「预设库」一键预填），再在「预设库→UA 伪装」选一条 Claude Code 工具 UA。
- 编辑渠道弹窗里的「拉取模型」**未保存也能拉**（走 `/api/channels/fetch-models` 草稿接口）：网关按 cc-switch 的候选链请求上游 `/v1/models`（仅 404/405 才换下一个候选；兼容 `/anthropic` 等子路径与 `/v4` 版本段结尾的 base），拉回模型列表后**点选即填入** models 字段（选一个填一个，也可一键全填）——纯拉取，没有「测试」语义。
- 工具的 base_url 填 `http://127.0.0.1:8787`，key 随便填一大串——**网关不看工具的 key**，真正生效的是每个渠道里存的 key（见「心智模型」）。
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

1. 入站原始头（凭证自动打码：authorization / x-api-key / x-goog-api-key / cookie 及其他 key/token/secret 名头打码）；
2. 出站改写头预览（按渠道配置 mock 计算，不真发上游）；
3. body 预览（截断 4KB）。

并现场返回 400，错误消息内嵌以上两份头的格式化 JSON——本地工具终端里直接可读。面板「捕获」页会留档最近 50 条，可展开看全量头、一键复制、清空。



##心智模型（UI 常驻文案）

> 工具的 key 填什么无所谓（网关不看它）；真正生效的是每个渠道存的 key；局域网暴露时再设网关 token。



##安全硬规则

- 绑定非 loopback 地址（0.0.0.0 / LAN IP）时，**强制要求**先设网关 token，该 token 同时保护 `/api` 管理端；loopback 绑定则免鉴权。
 Settings 页设置。

- 诚实边界：仅改写 HTTP 层请求头；若上游按 TLS 指纹风控（如 claude.ai 官方），换 UA 无效——那是 v2 的方向。
 预设库里对应条目已标注「暂不支持」。



##预设库

两层展示（照抄 cc-switch 结构）：

- **精选层**：人工核对过的 15–20 条知名常用渠道（Kimi、Zhipu GLM、Baidu、DeepSeek、OpenRouter、SiliconFlow、ModelScope、Moonshot 等）。
- **全部层**：从开源 cc-switch（MIT）的 `claudeProviderPresets.ts` 自动提取的约 50 条原样搬运，，标注「未逐一核实」；OAuth 类（Copilot/Codex/Grok）与协议不符的条目标「暂不支持」。

> 预设数据提取自开源 cc-switch（MIT），截至 2026-08，上游地址可能失效；如失效请各渠道官网确认后自行更正。重新提取：`pnpm extract-presets`。





##存储与备份

- 运行时数据存 `data/`（`lapi.db` + `config.json`），keys 明文存储于本地 SQLite（个人工具，与 new-api 同策略）。
- 备份 = 拷贝 `data/` 目录即可；`.gitignore` 已排除数据目录。





##测试

```bash
node scripts/e2e.mjs            # 端到端：本地假上游 8999，覆盖路由/认证注入/UA/SSE/failover（429 重试、5xx 耗尽、半路断流零重发）/捕获模式/双形态模型列表
pnpm test                       # 纯函数：URL 归一化、头改写（含受保护名单）、三级模型匹配、打码器
```

端到端全部通过即打印 `[e2e] ALL ASSERTIONS PASSED`。





## v1 明确不做

`messages` / `chat` / `responses` 三格式互转已支持**文本、工具调用、图片**（含流式增量、stop/usage/错误事件映射，见「对外端点」节）；仍不做：音频/嵌入/文件等多模态中继、hosted web_search 工具桥（遇到即 400 fail-closed）、OAuth 自动登录（Copilot/Codex/Grok）、多用户/计费/配额/Redis、TLS 指纹伪装——预设库对应条目一律标「暂不支持」，不装可用。
