# Try the roaming web client

Two ways to see it work. Both are real (real browser, real `goose roam share`,
real managed relays). No Tauri.

Prereqs: a built goose binary (`cargo build -p goose-cli` →
`target/debug/goose`) and a provider configured (you have Anthropic). The wasm
bindings are already built into `src/wasm/`; rebuild with `../build-web.sh` if
needed.

---

## A) Fastest: watch the automated proof (headless, ~30s)

Drives the whole flow in headless Chrome and prints each step.

```bash
cd mobile-web/webapp
pnpm install                                            # first run only
./serve.sh &                                            # serves on :5178
# point GOOSE_BIN at a `goose` binary built from the goose repo with
# --features roaming (this repo has no goose checkout):
GOOSE_BIN=/path/to/goose/target/debug/goose node tests/e2e.mjs
```

You'll see: share goes live → browser identity → accept → **CONNECTED THROUGH
RELAY** → **AGENT RESPONDED**. A screenshot lands at `/tmp/roam-e2e.png`.

---

## B) Drive it yourself in a real browser (see it with your eyes)

Two terminals.

### Terminal 1 — serve the web app
```bash
cd crates/goose-roaming/web/webapp
./serve.sh
```
Open <http://localhost:5178>. The page shows **this browser's card**
(`goose+roam://…`) and its key. Copy the card (there's a copy button).

### Terminal 2 — accept your browser, then share an agent
```bash
cd /Users/micn/Development/goose
G=./target/debug/goose

# 1. let this browser connect (paste the card you copied, keep the quotes)
$G roam peers accept 'goose+roam://…PASTE_BROWSER_CARD…'

# 2. start sharing an agent (runs in the dir you start it in). This blocks and
#    prints the HOST card:
$G roam share
```
Copy the `goose+roam://…` **host** card it prints.

### Back in the browser
Paste the **host** card into the box, hit **connect**. You should see
"connected to …", then type a message and watch the agent stream back.

Stop the host with Ctrl-C in Terminal 2.

---

## C) Drive it against a goose-gateway (no pairing, no relay)

Needs the `goose-gateway` binary (`gateway`) and a `goose` for its southbound
side. This path never loads the iroh wasm.

```bash
# terminal 1 — gateway (static auth = tenant headers on initialize)
gateway -listen :13300 -auth static -tenants t1=/var/lib/goose/t1

# terminal 2 — the app; same-origin /acp is proxied to the gateway
cd mobile-web/webapp
GOOSE_GATEWAY=http://127.0.0.1:13300 pnpm dev
```

Open <http://localhost:5178?gateway=1> (the query forces the gateway branch and
skips the wasm download). Pick **gateway**, leave the URL blank, fill
`tenant id`, hit **connect** → **+ New session** → chat. `session/list` comes
from the gateway itself, so you only see this tenant's sessions.

With `-auth jwt`, switch the auth mode and paste the bearer token instead — it
is sent on every request.

Production = same thing behind a same-origin reverse proxy: the gateway serves
no CORS, so a cross-origin URL will fail by design (the UI says so). Keep
response buffering off for `/acp` (nginx: `proxy_buffering off;`) or the SSE
stream sits in the proxy's buffer.

Automated equivalent of everything above, no gateway binary needed:

```bash
node tests/gateway-smoke.mjs     # mocks the transport, drives the real UI twice
node tests/gateway-live.mjs      # same assertions against a running gateway
#   GOOSE_GATEWAY_URL=http://192.168.3.19:7731 TENANT=t1 USER_ID=u1 \
#     node tests/gateway-live.mjs
node tests/dist-proxy.mjs        # built dist/ behind a streaming reverse proxy
#   GOOSE_GATEWAY_URL=http://192.168.3.19:7731 TENANT=t1 USER_ID=u1 \
#     node tests/dist-proxy.mjs
```

---

### Notes / gotchas
- **Order matters**: accept the browser key *before* (or during) `roam share` —
  the live share re-reads the allowlist per connection, so accepting after it's
  running also works.
- The browser generates a stable identity (persisted in `localStorage`), so you
  only `accept` it once per browser profile.
- If connect hangs: the managed relays must be reachable (they're
  `*.relay.michaelneale.mesh-llm.iroh.link`). The web client strips the card's
  trailing-dot relay host so the browser TLS/SNI is happy.
- Current limitations: main-thread (no worker), no reconnect, key in localStorage.
