# goose roam — web client

A browser chat client that connects to a `goose roam share` agent **over iroh,
entirely in the browser** (iroh compiled to wasm, relay-only via
WebSocket-to-relay). No Tauri, no Electron, no local bridge process — the
browser tab itself is the roam peer.

The same build also connects **straight to a `goose-gateway`** over ACP
Streamable HTTP (`new GooseClient(client, gatewayUrl)`) — no pairing, no relay,
no wasm. The transport is picked per target: a `goose+roam://` card is P2P, a
URL is a gateway.

The UI is a **React app that reuses goose's reference clients**, vendored under
`src/vendor/` (hand-synced copies from the goose repo; no path dependency):

- **`@aaif/goose-sdk`** (`src/vendor/goose-sdk`, via vite alias) —
  `GooseClient` is the protocol layer; our roam byte-duplex is exactly the
  `Stream` it expects.
- **`@desktop/*`** (`src/vendor/desktop`, imported as source) — the desktop's
  real `MarkdownContent` (react-markdown + remark-gfm + katex + syntax
  highlighting) renders agent messages; `ToolCallStatusIndicator` provides tool
  status dots; the desktop's full Tailwind v4 theme (`styles/main.css`) is
  imported so the components carry their real styles. A ~10-line
  `window.electron` shim (`shim.ts`) covers the Electron-only APIs
  `MarkdownContent` calls (`openExternal` → `window.open`), and `IntlProvider`
  renders react-intl `defaultMessage` fallbacks (no compiled catalog shipped).

Plus app-local widgets: tool-call cards that update in place, collapsible
thinking blocks, a plan checklist, inline non-blocking permission cards (never
`window.confirm`, which would freeze the ACP message pump), and a session
sidebar (list / load-with-history-replay / new).

Still stateless + CDN-hostable: static files only, no backend, all traffic
browser ⇄ relay ⇄ roam host. Still deliberately lean: main thread only, text
prompts, no reconnect. Hardening is tracked in `../README.md`.

## The stack (all in the tab)

```
iroh (wasm, relay-only) ── roam handshake ──► authorized ACP byte duplex
     │  goose_roaming_web.wasm (RoamClient / RoamConnection)
     ▼  roamByteStreams()
Web Streams <Uint8Array>
     ▼  ndJsonStream()                (@agentclientprotocol/sdk)
Stream<AnyMessage>
     ▼  new GooseClient(client, stream)        (@aaif/goose-sdk — vendored)
typed ACP: initialize / listSessions / newSession / loadSession / prompt
           / sessionUpdate / requestPermission
     ▼
React chat UI reusing vendored ui/desktop components
(MarkdownContent · ToolCallStatusIndicator · desktop Tailwind theme)
```

The wasm module (`../goose-roaming-web`) does **only** the transport: hold a
roam identity keypair, decode a `goose+roam://` card, dial relay-only, run the
roam handshake, and expose a byte duplex. Everything ACP-shaped is the existing
TypeScript SDK. Nothing about the protocol is hand-rolled.

## Build & run

```bash
# 1. build the wasm transport module + generate JS bindings
#    (script is self-locating; run it from anywhere)
mobile-web/build-web.sh

# 2. run the app
cd mobile-web/webapp
pnpm install
pnpm dev                       # http://localhost:5178
```

`build-web.sh` compiles `goose-roaming-web` to wasm (via `build-wasm.sh`) and
runs `wasm-bindgen --target web` into `webapp/src/wasm/`.

## Pairing (two-way, like the CLI)

1. Open the app. It generates a per-browser roam identity (persisted in
   `localStorage`) and shows **this browser's key**.
2. On the host: `goose roam peers accept <that key>` (one time).
3. On the host: `goose roam id` → copy the `goose+roam://…` card.
4. Paste the card into the app → **connect**.

Both sides have chosen to trust the other's key — the same mutual card-swap two
CLIs do. The host runs the real agent (its tools, shell, cwd); the browser is a
pure ACP client.

## Direct gateway (no pairing, no relay)

The connect panel has a **gateway** mode next to **roam card**. A gateway
target is just a base URL; the client appends `/acp` and speaks the same ACP
Streamable HTTP the gateway's northbound side serves (`initialize` → 200 +
`Acp-Connection-Id`, business frames POSTed, responses + server pushes arriving
on GET SSE).

```bash
# terminal 1 — the gateway (from the goose-gateway repo)
gateway -listen :13300 -auth static -tenants t1=/var/lib/goose/t1

# terminal 2 — the app; the dev proxy forwards same-origin /acp to it
cd mobile-web/webapp
GOOSE_GATEWAY=http://127.0.0.1:13300 pnpm dev
```

Then in the app: **gateway** → leave the URL **blank** (blank = this origin,
i.e. the proxy) → pick the auth mode → **connect**.

- **`-auth static`** (default, local/intranet): the form's `X-Tenant-Id` /
  `X-User-Id` go on the `initialize` POST only — the gateway binds identity to
  the connection id there.
- **`-auth jwt`** (production): the token is sent as `Authorization: Bearer` on
  **every** request.

Auth + URL are saved in the same `localStorage` hosts table as roam cards
(`goose-roam-hosts`), so reload reconnects. Treat that storage as sensitive: a
remembered JWT is readable by anything that can run script in the page.

### CORS / hosting

The gateway implements **no CORS** at all, so the browser can only reach it
same-origin:

- **dev** — `vite.config.ts` proxies `/acp` to `GOOSE_GATEWAY`
  (default `http://127.0.0.1:13300`). The gateway's connection stream sends
  response headers and then nothing until the first frame, and node only flushes
  a proxied response on its first body byte — so the proxy entry takes `/acp`
  over (`selfHandleResponse`) and calls `flushHeaders()`, otherwise the GET
  stream never opens;
- **prod** — serve the static build behind a reverse proxy that forwards
  `/acp` to the gateway (nginx/caddy/`vite preview` all work). Keep response
  buffering off for that path (nginx: `proxy_buffering off;`) so SSE frames are
  not parked in the proxy's buffer;
- a cross-origin static host (GitHub Pages form) needs a gateway CORS
  preflight — out of scope here.

### Gateway-only builds

`VITE_GATEWAY_ONLY=1 pnpm build` ships no iroh wasm chunk at all (verified:
`dist/` contains no `.wasm`). A gateway-only *boot* (URL target, `?gateway=1`,
or no roam card ever used) also skips `initWasm()` at runtime, so the wasm is
never fetched; `load P2P transport` pulls it in on demand if you paste a card
later.

### Method surface

Only what the gateway's rules table passes is called
(`session/new|load|prompt|cancel|set_mode|set_config_option|list`,
`_goose/unstable/session/steer`) plus `_goose/unstable/sources/list`, which the
gateway refuses with `-32601` and the UI already swallows into an empty project
map. Model changes go through `session/set_config_option` (`session/set_model`
is gateway-refused). Reverse requests the client has no UI for are answered
`-32601` immediately instead of hanging — explicitly for `elicit/create`,
`terminal/*`, `fs/*` and every extension method, because the SDK otherwise
answers `result: null` for `terminal/*`/`fs/*` and the gateway would read that
as a successful ask. Gateway error codes are mapped to UI
copy in `src/gateway.ts` (`-32601` → 该操作不可用, `-32001` → 会话忙，请稍后重试,
`-32002`/`-32003` → trace id …); auth headers are never logged.

See `docs/gateway-integration-tasks.md` for the full checklist.

## Smoke test (proves the wasm runs in a browser)

```bash
pnpm dev                       # in one shell (serves on :5178)
node tests/smoke.mjs           # in another
```

`tests/smoke.mjs` drives headless Google Chrome via Playwright (uses the
system Chrome via `channel: "chrome"`, so no `playwright install` needed) and
asserts the wasm instantiates, generates an ed25519 keypair, round-trips a
`goose+roam://` card through the decoder, and persists identity — with no
console errors. This isolates "does the browser wasm run" from the live
relay/handshake path.

## Gateway transport test (auth, errors, method surface)

```bash
node tests/gateway-smoke.mjs
```

Spawns `tests/gateway-mock.mjs` (a Node stand-in for the gateway transport on
`:13399` — frames over POST + SSE, `-auth static`/`-auth jwt` verification, the
rules table, error injection, one reverse request per connection) plus a Vite
dev server on `:5199` aimed at it through `GOOSE_GATEWAY`, then drives the real
UI in system Chrome twice, once per auth mode. It asserts: no wasm request on a
gateway boot, `?gateway=1` preselects the gateway form, tenant-scoped
`session/list`, a streamed prompt reply, `-32001` (会话忙，请稍后重试) and
`-32002` copy with trace id, a model change riding `session/set_config_option`
(`session/set_model` is never called), **stop** sending `session/cancel` and
clearing the held turn, `sources/list -32601` degrading silently in the
UI, tenant+user headers on initialize only (static) or `Bearer` on **every**
request (jwt), both reverse requests refused `-32601`, and no auth material
anywhere in the console. Everything is torn down at the end — no real gateway
binary needed.

## Live gateway acceptance (a real `goose-gateway`)

```bash
GOOSE_GATEWAY_URL=http://192.168.3.19:7731 TENANT=t1 USER_ID=u1 \
  node tests/gateway-live.mjs
```

The same UI assertions as `gateway-smoke`, but against a **running gateway**
through the dev proxy (port `:5200`, `VITE_PORT` to override): gateway-only
boot with no wasm request, `initialize` carrying `X-Tenant-Id`/`X-User-Id`
(static mode) and no identity headers on any later request, no `Authorization`
anywhere, `session/list` rendered, no console errors or auth material. With
the southbound goose running it takes the success path: `session/new` opens a
session and a prompt must come back `PONG`. If goose never came up (the
gateway was launched without `-south-secret` / `-goose-config`), `session/new`
answers `-32002`, and the run asserts the user sees the mapped copy with the
trace id (`服务暂不可用（trace: …）`) — never a raw JSON-RPC blob. Every frame is
traced (`ACP_DEBUG`) and the `/acp` traffic plus a gateway-side subscriber
probe are printed for diagnosis.

Two live-only findings already folded back into the app: the dev proxy has to
flush SSE headers itself (above), and a failed `session/new` on the
session-matrix front page has no chat log to land in, so `App.tsx` mirrors the
mapped copy onto the status line. `gateway-mock.mjs` keeps the same
headers-only stream (no `: ok` first frame) so `gateway-smoke` sees a proxy
that fails to flush upstream headers too. A third: the gateway's
`configOptions[].options[]` entries carry `value`, never `id` — keyed and
submitted by `id` they produced undefined React keys (the "unique key prop"
warning on opening the settings panel) and `<option>` values falling back to
their labels, so the type, the panel and the mock all use `value` now.

`gateway-live` also covers the rest of the round trip: opening a **pre-existing
session** from the list (`session/load` + history replay, no error) and an
8-second **offline drop** (`reconnecting…` → `#reconnect-panel` → automatic
redial → the open session resumes). Against the real gateway a second viewer
on a busy session behaves as designed: its `session/prompt` answers `-32001`
and the UI shows `error: 会话忙，请稍后重试` (never a raw blob), while its
session-scoped GET gets `409` (one subscriber per session) — now downgraded to
an ACP debug trace in `http-stream.ts`, since the responses still arrive on
the connection stream.

## Built artifact behind a reverse proxy (acceptance ⑤)

```bash
node tests/dist-proxy.mjs                      # mock gateway, self-contained
GOOSE_GATEWAY_URL=http://192.168.3.19:7731 TENANT=t1 USER_ID=u1 \
  node tests/dist-proxy.mjs                    # live stack (SKIP_BUILD=1 reuses dist/)
```

Runs `vite build` and serves `dist/` from a Node reverse proxy on `:5221`
that forwards `/acp` streaming (`writeHead` + `flushHeaders` + `pipe` — the
Node equivalent of nginx's `proxy_buffering off`) and everything else from
disk with SPA fallback. Asserted in a real browser: the page boots from the
hashed bundle (no `/@vite/` or react-refresh requests), gateway mode with a
blank URL means same-origin `/acp`, connect + `session/new` + a prompt
round-trip all cross the proxy, and there is no wasm, no auth material and no
console error anywhere.

## Status

Proven end to end. Build-time green (`tsc` clean vs ACP SDK 0.19.0,
Vite bundles), in-browser wasm runtime green (`tests/smoke.mjs`), **gateway
transport green** (`tests/gateway-smoke.mjs`, both auth modes), **live
gateway green** (`tests/gateway-live.mjs`), **acceptance ⑤ green**
(`tests/dist-proxy.mjs`: built `dist/` behind a streaming same-origin reverse
proxy), and a **live round trip green** (`tests/e2e.mjs`: real Chrome →
managed relay → running `goose roam share` → agent response).
`tests/visual.mjs` captures the rendered GUI (markdown + tool widget +
session sidebar) as a screenshot.

Hardening tracked in `../README.md`: Web Worker, reconnect, backpressure
tuning, key security, revocation-closes-connections.
