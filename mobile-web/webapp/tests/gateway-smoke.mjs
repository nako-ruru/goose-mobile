// End-to-end check of the *gateway* transport, using tests/gateway-mock.mjs in
// place of the real goose-gateway binary (this machine has no Go gateway):
//
//   1. ?gateway=1 boots without fetching the iroh wasm
//   2. ConnectPanel's gateway branch: URL (blank = same origin) + auth form
//   3. vite dev proxies same-origin /acp to GOOSE_GATEWAY (the gateway has no CORS)
//   4. static auth sends X-Tenant-Id on initialize ONLY; jwt sends Bearer on
//      every request; neither ever reaches the console
//   5. session/list comes from the gateway (tenant-filtered); new + a streamed
//      prompt round-trip; a model change goes out as session/set_config_option
//      (never session/set_model); stop sends session/cancel and resolves the
//      held turn; sources/list -32601 degrades silently in the UI
//   6. -32001/-32002 map to UI copy (trace id included); reverse requests are
//      refused with -32601 instead of hanging
//
//   node tests/gateway-smoke.mjs
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import { startGatewayMock } from "./gateway-mock.mjs";

const GATEWAY_PORT = 13399;
const VITE_PORT = 5199;
const BASE = `http://localhost:${VITE_PORT}`;
const failures = [];
const log = (...a) => console.log("  ", ...a);
const check = (cond, msg) => (cond ? log(`✓ ${msg}`) : failures.push(msg));

function startVite(gatewayUrl) {
  const child = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--port", String(VITE_PORT), "--strictPort"],
    {
      env: { ...process.env, GOOSE_GATEWAY: gatewayUrl, BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.on("data", (d) => {
    const s = d.toString();
    if (/error/i.test(s)) process.stderr.write(`  [vite] ${s}`);
  });
  // Drain stdout too (a full pipe would stall vite) and surface client console
  // output that lands here instead of on stderr.
  child.stdout.on("data", (d) => {
    const s = d.toString();
    if (/\[console\.(error|warn)\]/.test(s)) process.stderr.write(`  [vite] ${s}`);
  });
  return child;
}

async function waitForVite(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`vite dev server never came up on ${BASE}`);
}

async function scenario(browser, mode) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleErrors = [];
  const leaks = [];
  const wasmRequests = [];
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error") consoleErrors.push(t);
    if (/authorization|bearer|x-tenant-id|x-user-id/i.test(t)) leaks.push(t);
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("request", (r) => {
    if (/\.wasm(\?|$)/.test(r.url())) wasmRequests.push(r.url());
  });

  console.log(`\n— ${mode} auth —`);
  await page.goto(`${BASE}/?gateway=1`, { waitUntil: "domcontentloaded" });

  await page.locator("#gateway-url").waitFor({ state: "visible", timeout: 30000 });
  check(wasmRequests.length === 0, "gateway boot fetched no wasm");
  check(
    (await page.locator("#mode-gateway").getAttribute("aria-pressed")) === "true",
    "gateway mode preselected (?gateway=1)",
  );
  check(
    await page.locator("#card-input").isHidden(),
    "roam card textarea hidden in gateway mode",
  );

  if (mode === "static") {
    await page.fill("#gateway-tenant", "t1");
    await page.fill("#gateway-user", "u1");
  } else {
    await page.selectOption("#gateway-auth", "jwt");
    await page.fill("#gateway-token", "tok-abc");
  }
  await page.click("#gateway-connect");

  await page.locator("#status").waitFor({ state: "visible", timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent?.trim() === "connected",
    undefined,
    { timeout: 30000 },
  );
  log("✓ connected");
  // Session list arrives just after "connected" — wait for it rather than race.
  const listOk = await page
    .waitForFunction(
      () => document.querySelector("#session-list")?.textContent?.includes("tenant t1 session"),
      undefined,
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false);
  check(listOk, "session/list served by the gateway (tenant-scoped)");
  check(wasmRequests.length === 0, "no wasm fetched across the whole session");

  // New session + a streamed turn.
  await page.click("#new-session");
  await page.locator("#prompt-input").waitFor({ state: "visible", timeout: 15000 });
  await page.fill("#prompt-input", "hello there");
  await page.click("#send-btn");
  await page.waitForFunction(
    () => document.querySelector("#log")?.textContent?.includes("hello from the mock gateway"),
    undefined,
    { timeout: 20000 },
  );
  log("✓ prompt streamed a reply");

  // Error-code → UI copy (-32001, -32002 + trace id).
  await page.fill("#prompt-input", "busy please");
  await page.click("#send-btn");
  await page.waitForFunction(
    () => document.querySelector("#log")?.textContent?.includes("会话忙"),
    undefined,
    { timeout: 15000 },
  );
  log("✓ -32001 → 会话忙，请稍后重试");

  await page.fill("#prompt-input", "unavailable please");
  await page.click("#send-btn");
  await page.waitForFunction(
    () => document.querySelector("#log")?.textContent?.includes("tr_mock_9"),
    undefined,
    { timeout: 15000 },
  );
  log("✓ -32002 → trace id shown");

  // sources/list is refused with -32601: project grouping degrades, no error.
  await sleep(1500);
  const logText = await page.locator("#log").textContent();
  check(
    !/sources\/list|_goose\/unstable\/sources/i.test(logText),
    "sources/list -32601 degraded silently in the UI",
  );

  // Model change must ride session/set_config_option — session/set_model is
  // DENYed by the gateway's rules table.
  await page.click("#session-config-btn");
  await page.locator("#session-config select").waitFor({ state: "visible", timeout: 15000 });
  await page.locator("#session-config select").selectOption("mock-b");
  await page.waitForFunction(
    () => document.querySelector("#model-badge")?.textContent?.includes("Mock B"),
    undefined,
    { timeout: 15000 },
  );
  log("✓ model changed, badge updated from set_config_option's response");

  // Stop a held turn: session/cancel goes out and the prompt resolves as
  // cancelled, so busy state clears instead of hanging.
  await page.fill("#prompt-input", "slow turn please");
  await page.click("#send-btn");
  await page.locator("#stop-turn").waitFor({ state: "visible", timeout: 15000 });
  await page.click("#stop-turn");
  await page.waitForFunction(
    () => document.querySelector("#log")?.textContent?.includes("cancelled"),
    undefined,
    { timeout: 15000 },
  );
  log("✓ stop button sent session/cancel and the turn ended");

  await ctx.close();
  return { consoleErrors, leaks, wasmRequests };
}

const browser = await chromium.launch({ headless: true, channel: "chrome" });
let mock;
let vite;
let s1;
let s2;

try {
  mock = await startGatewayMock({ port: GATEWAY_PORT, mode: "static" });
  vite = startVite(`http://127.0.0.1:${GATEWAY_PORT}`);
  await waitForVite();

  s1 = await scenario(browser, "static");

  // --- assertions on what the mock saw (static mode) ---
  const init = mock.observations.find((o) => o.phase === "initialize");
  check(!!init?.ok, "static: initialize accepted");
  check(init?.tenant === "t1" && init?.user === "u1", "static: tenant+user on initialize");
  const later = mock.observations.filter((o) => o.phase !== "initialize");
  check(
    later.length > 0 && later.every((o) => o.tenant === null && o.user === null),
    `static: tenant headers sent on initialize only (${later.length} later requests clean)`,
  );
  check(
    later.every((o) => o.bearer === null),
    "static: no Authorization header anywhere",
  );

  const reply = mock.askReplies.find((r) => r.id === 4242);
  const extReply = mock.askReplies.find((r) => r.id === 4243);
  check(
    reply?.error?.code === -32601,
    `reverse request (terminal/create) refused -32601 (got ${JSON.stringify(reply?.error ?? reply)})`,
  );
  check(
    extReply?.error?.code === -32601,
    `reverse request (ext method) refused -32601 (got ${JSON.stringify(extReply?.error ?? extReply)})`,
  );

  check(s1.leaks.length === 0, `no auth header in the console (${s1.leaks.join(" | ")})`);
  // The SDK logs every refused reverse request as console.error — that is the
  // expected shape of this test, not a client bug.
  const realErrors = s1.consoleErrors.filter(
    (e) => !/favicon/i.test(e) && !/Error handling request/.test(e),
  );
  check(
    realErrors.length === 0,
    `no console errors (${realErrors.join(" | ")})`,
  );

  // Method surface: everything must be inside the gateway's PASS set.
  const cfgCalls = mock.observations.filter((o) => o.method === "session/set_config_option");
  check(
    cfgCalls.length === 1 &&
      cfgCalls[0].params?.configId === "model" &&
      cfgCalls[0].params?.value === "mock-b",
    `model change sent as session/set_config_option (${JSON.stringify(cfgCalls[0]?.params)})`,
  );
  check(
    mock.observations.every((o) => o.method !== "session/set_model"),
    "session/set_model never called (gateway-DENY)",
  );
  check(
    mock.observations.filter((o) => o.method === "session/cancel").length === 1,
    "stop button sent session/cancel",
  );
  log(
    "methods seen:",
    [...new Set(mock.observations.filter((o) => o.method).map((o) => o.method))].sort().join(", "),
  );

  // --- jwt mode: bearer on every request ---
  const mockJwt = await startGatewayMock({ port: GATEWAY_PORT + 1, mode: "jwt" });
  vite.kill();
  await sleep(500);
  vite = startVite(`http://127.0.0.1:${GATEWAY_PORT + 1}`);
  await waitForVite();

  s2 = await scenario(browser, "jwt");
  const jwtInit = mockJwt.observations.find((o) => o.phase === "initialize");
  const jwtLater = mockJwt.observations.filter((o) => o.phase !== "initialize");
  check(jwtInit?.ok, "jwt: initialize carried a bearer token");
  check(
    jwtLater.length > 0 &&
      jwtLater.every((o) => o.bearer === `Bearer tok-abc`) &&
      jwtLater.every((o) => o.tenant === null),
    `jwt: bearer on every request, tenant headers never (${jwtLater.length} requests)`,
  );
  check(
    mockJwt.askReplies.some((r) => r.id === 4242 && r.error?.code === -32601) &&
      mockJwt.askReplies.some((r) => r.id === 4243 && r.error?.code === -32601),
    "jwt: both reverse requests refused -32601",
  );
  check(s2.leaks.length === 0, `jwt: no auth header in the console (${s2.leaks.join(" | ")})`);
  const realErrors2 = s2.consoleErrors.filter(
    (e) => !/favicon/i.test(e) && !/Error handling request/.test(e),
  );
  check(realErrors2.length === 0, `jwt: no console errors (${realErrors2.join(" | ")})`);
  check(
    mockJwt.observations.every((o) => o.method !== "session/set_model") &&
      mockJwt.observations.some((o) => o.method === "session/set_config_option") &&
      mockJwt.observations.some((o) => o.method === "session/cancel"),
    "jwt: same method surface (set_config_option + cancel, no set_model)",
  );
  await mockJwt.close();
} catch (err) {
  failures.push(`exception: ${err?.stack ?? err}`);
} finally {
  vite?.kill();
  await mock?.close();
  await browser.close();
}

if (failures.length) {
  console.error(`\n✗ GATEWAY SMOKE FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n✓ GATEWAY SMOKE PASSED — client ↔ gateway transport, auth, errors\n");
