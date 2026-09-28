# goose-mobile web 客户端对接 gateway —— 修改清单

> 给实现 AI。基准形态 = 2026-09 选型结论：**用 roam-web（本仓）作 web 客户端基准**（评分 15.5 vs
> goose ui/desktop 14.0：Electron 拆解 263 处 IPC、扩展安装/provider 密钥在多租户下是负资产、
> 传输层 http-stream 与网关同协议）。本清单只改**连接目标与认证**，不动 UI 结构。

## 0. 基线与工作区

- 源码 = `origin/mobile-web-client` 分支 `mobile-web/webapp/`（React 19 + Vite，13.4K 行）。
  当前 checkout 的 `roam-web` 分支**只是构建产物**，勿在其上改源码。
  旧源码 worktree `/tmp/opencode/roam-webapp-wt` 已删除 →
  `git worktree add /tmp/opencode/roam-webapp origin/mobile-web-client`（或 `checkout -b`）。
- SDK pin：`@agentclientprotocol/sdk` **0.19.0 勿升级**。
- 网关事实源（以仓内文件为准）：`goose-gateway/internal/transport/http.go` 头注释（北向线格式）、
  `goose-gateway/internal/rules/rules.go`（30 条方法裁决表）、`goose-gateway/docs/m1-gateway-design.md`、
  `goose-gateway/cmd/gateway/main.go`（flags）。

## 1. 传输接入（核心，~10 行）

- `GooseClient` 本来就收 `Stream | string`：**网关路径 = `new GooseClient(makeClient, gatewayUrl)`**
  ——连线点在 `App.tsx` L726–732（原 `roam.connect(card, ...)` + `roamByteStreams(conn)` 那几行）。
- 网关北向线格式 = goose serve ACP Streamable HTTP（已验证同形，e2e 北向 client 同协议）：
  - `initialize` POST → 200 + `Acp-Connection-Id` 响应头（直回，不进流）；
  - GET 无 `Acp-Session-Id` → 连接流（单订阅者，第二个 409）；
  - GET 带 `Acp-Session-Id`（**中央 id**）→ 会话流（网关做归属校验）；
  - 业务帧 POST 发送。
  客户端 vendored `http-stream.ts`（L245/L310 两处 POST）实现的正是这套，**传输层零改动**。
- P2P shim：写一个假 `RoamClient` —— `myCard()`/`endpointId()` 返回占位值、
  `connect(_card, ...)` 无视参数直接返回 gatewayUrl 的 HTTP stream；
  `roamByteStreams` 与整个 App 结构原样不动。
- **wasm / iroh / QR 相关源码一行不删**（P2P 形态保留）；但网关路径**不实例化 iroh wasm**
  （运行时不加载，构建产物去掉 3.8MB wasm）。

## 2. 认证（~5 行，vendored `http-stream.ts` 的 fetch 注入）

对应网关 `-auth` flag 两种模式（`cmd/gateway/main.go:110-114`）：

| 模式 | 客户端要做的 |
|---|---|
| `static`（默认，本地/内网） | `X-Tenant-Id` / `X-User-Id` **只在 initialize POST** 上带；网关把身份绑到连接，后续请求凭 `Acp-Connection-Id` 认主体 |
| `jwt`（生产，Logto） | **每个请求**带 `Authorization: Bearer <token>`，token 身份必须与连接绑定身份一致 |

- gateway URL 与认证配置存 localStorage（可复用 hosts 表结构）；token 来源 = 平台登录态。

## 3. 连接引导 UI

- `ConnectPanel` 加"直连网关"分支：填 gateway URL（+ tenant/user 或 token）→ 跳过配对/QR 故事线。
- 配对、QR、hosts 相关代码**保留不删**，只是网关模式不走它们。

## 4. 方法面对照（核对 `internal/rules/rules.go` 里的实际调用点）

- **照常可用（PASS）**：`session/new`、`session/load`（网关剥 mcpServers + 换 cwd，客户端无感）、
  `session/prompt`、`session/cancel`、`session/set_mode`、`session/set_config_option`、
  `session/delete`、`session/close`、`session/fork`、
  **`session/list`（网关中央直出，按租户过滤——列表只见本租户）**、
  `_goose/unstable/session/{info,export,import,rename,archive,unarchive,project/update,steer,
  working-dir/update,system-prompt/set}`。
- **必须改的调用点**：`session/set_model` 网关恒拒 → 设置面板回写一律改调
  `session/set_config_option(configId="model", value=...)`。
- **必须容错的**：
  - `_goose/unstable/sources/list` 网关恒 `-32601`（无归属路由，已拍板默认拒绝）
    → 保留现有 `try/catch → {}` 容错；项目分组走 `sessions.ts` 的无项目名兜底；
  - `session/resume`、`session/extensions/*`、`live-voice/*`、`conversation/truncate`、
    `share/nostr`、`schedules/*` 全 DENY → UI 不提供入口或静默降级，不弹错误。
- 未在规则表里的方法 = `-32601`：新增任何调用先查表。

## 5. 反向请求与通知

- 网关会把实例侧的**反向请求**透传给北向客户端（elicitation/form 等）：
  应答帧 = `POST {id, result|error}`（无 method）。客户端按 SDK 既有 request handler 接，
  **必须给默认应答（拒绝）而不是挂起**；应答 id 只回本连接收到过的（网关有资格校验）。
- 通知（session/update 等）走会话流，SDK 原生处理，无改动。

## 6. 错误码映射（北向不透传内部原文，R7 同口径）

| 码 | 含义 | UI 文案 |
|---|---|---|
| `-32601` | 方法被拒 / 无归属 | "该操作不可用" |
| `-32602` | 参数被清洗 | 静默忽略或轻提示 |
| `-32001` | busy / 配额 | "会话忙，请稍后重试" |
| `-32002` | 只带 trace_id | 展示 trace_id |
| `-32003` | 后端错误 | "服务内部错误（trace: …）" |

- 前端日志**不得打印** `Authorization` / 静态租户头 / token。

## 7. 跨域与托管（决策点）

- 网关**没有 CORS 实现**：
  - 开发：vite dev proxy 同源转发（`/` → `http://127.0.0.1:13300`）；
  - 生产：**同域反代**（推荐，零网关改动）；
  - 若必须跨域静态站（GitHub Pages 形态）→ 需网关补 CORS preflight（另开单）。
- `pnpm build` 出纯静态产物，任意静态托管。

## 8. 依赖（运行前置；无新增第三方库）

- 网关：`gateway -listen :13300 -auth static -tenants t1=/dir/t1,...`
  （可选 `-exec -goose-bin /opt/goose/goose` 每会话 bwrap 沙箱、`-store-dsn` PG 真相落库）。
- 执行体：默认共享单实例（连 `-south` goose serve）。
- **不阻塞项**：ACP→turn 派发路由（交接单 1c，主理人拍板中）——那是网关南侧另一条执行路径；
  web → 网关 → Local 执行体现在就能端到端跑通，本清单不等它。

## 9. 验收

1. vite dev 指网关：连接 → `session/new` → `session/prompt` 流式回显 → 关开 →
   `session/list` 中央直出且只见本租户；
2. 设置面板改模型走 `set_config_option` 生效；
3. `sources/list` 被拒 → 项目分组降级不报错；
4. `session/cancel` 打断、并发 `-32001` busy 文案；
5. `pnpm build` 产物 + 同域反代真机过一遍；
6. 控制台/日志无 Authorization、租户头、token 泄漏。
