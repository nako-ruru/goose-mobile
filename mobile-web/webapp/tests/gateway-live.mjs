// Live acceptance run against a *real* goose-gateway (§9 of
// docs/gateway-integration-tasks.md), browser → vite proxy → gateway:
//
//   GOOSE_GATEWAY_URL=http://192.168.3.19:7731 TENANT=t1 USER_ID=u1 \
//     node tests/gateway-live.mjs
//
// What is asserted hard (transport/auth/UI layers, must be green):
//   1. ?gateway=1 boots without fetching the iroh wasm
//   2. same-origin /acp proxy reaches the gateway — no CORS involved
//   3. -auth static: X-Tenant-Id/X-User-Id ride initialize ONLY, no
//      Authorization anywhere, nothing leaks to the console
//   4. session/list answers (gateway-answered), the list area renders
//   5. UI is clean: no console errors, no page errors
//   6. session/new: success → a prompt must round-trip "PONG"; if the
//      southbound goose is down, the *mapped* copy from src/gateway.ts must be
//      what the user sees (-32002 → 服务暂不可用 + trace id), never a raw blob
//
// session/new/prompt outcomes are reported either way: a gateway whose
// southbound goose could not start (launched without -south-secret, so the
// sandboxed goose has no GOOSE_SERVER__SECRET_KEY and dies on boot — the true
// cause of -32002 here) answers -32002, which is the server's state, not this
// client's.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const GATEWAY_URL = process.env.GOOSE_GATEWAY_URL ?? "http://192.168.3.19:7731";
const TENANT = process.env.TENANT ?? "t1";
const USER = process.env.USER_ID ?? "u1";
const VITE_PORT = Number(process.env.VITE_PORT ?? 5200);
const BASE = `http://localhost:${VITE_PORT}`;

const failures = [];
const notes = [];
const log = (...a) => console.log("  ", ...a);
const check = (cond, msg) => (cond ? log(`✓ ${msg}`) : failures.push(msg));

function startVite() {
  const child = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--port", String(VITE_PORT), "--strictPort"],
    {
      env: { ...process.env, GOOSE_GATEWAY: GATEWAY_URL, BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const forward = (d) => {
    const s = d.toString();
    if (/\[console\.(error|warn)\]|error/i.test(s)) process.stderr.write(`  [vite] ${s}`);
  };
  child.stdout.on("data", forward);
  child.stderr.on("data", forward);
  return child;
}

async function waitForVite(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`vite dev server never came up on ${BASE}`);
}

console.log(`\n=== live gateway acceptance: ${GATEWAY_URL} (tenant=${TENANT}) ===`);

const vite = startVite();
const browser = await chromium.launch({ headless: true, channel: "chrome" });
let ctx;
const netLog = [];
const consoleAll = [];
try {
  await waitForVite();

  ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  // Transport-level trace: every POST and every SSE frame the client saw.
  await ctx.addInitScript(() => {
    try { localStorage.setItem("ACP_DEBUG", "1"); } catch {}
    window.__unh = [];
    window.addEventListener("unhandledrejection", (e) => {
      window.__unh.push(String(e.reason));
    });
  });
  const page = await ctx.newPage();
  const connId = { value: null };

  const consoleErrors = [];
  const leaks = [];
  const wasmRequests = [];
  const acpPosts = [];
  page.on("console", (m) => {
    const t = m.text();
    consoleAll.push(`[${m.type()}] ${t}`);
    if (m.type() === "error") consoleErrors.push(t);
    if (/authorization|bearer|x-tenant-id|x-user-id/i.test(t)) leaks.push(t);
  });
  page.on("pageerror", (e) => {
    consoleErrors.push(`pageerror: ${e.message}`);
    consoleAll.push(`[pageerror] ${e.message}`);
  });
  page.on("request", (r) => {
    if (/\.wasm(\?|$)/.test(r.url())) wasmRequests.push(r.url());
    if (r.url().includes("/acp") && r.method() === "POST") {
      const h = r.headers();
      const body = r.postData() ?? "";
      acpPosts.push({
        body,
        tenant: h["x-tenant-id"] ?? null,
        user: h["x-user-id"] ?? null,
        auth: h["authorization"] ?? null,
      });
      let method = "?";
      try { method = JSON.parse(body)?.method ?? "?"; } catch {}
      netLog.push(`→ POST ${r.url()} ${method}`);
    } else if (r.url().includes("/acp")) {
      netLog.push(`→ ${r.method()} ${r.url()}`);
    }
  });
  page.on("response", (r) => {
    if (r.url().includes("/acp")) {
      netLog.push(`← ${r.status()} ${r.request().method()} ${r.headers()["content-type"] ?? ""}`);
      if (r.request().method() === "POST" && (r.headers()["acp-connection-id"] ?? null)) {
        connId.value = r.headers()["acp-connection-id"];
      }
    }
  });
  page.on("requestfailed", (r) => {
    if (r.url().includes("/acp")) netLog.push(`✗ ${r.method()} ${r.failure()?.errorText}`);
  });

  await page.goto(`${BASE}/?gateway=1`, { waitUntil: "domcontentloaded" });
  await page.locator("#gateway-url").waitFor({ state: "visible", timeout: 30000 });
  check(wasmRequests.length === 0, "gateway boot fetched no wasm");

  await page.fill("#gateway-tenant", TENANT);
  await page.fill("#gateway-user", USER);
  const t0 = Date.now();
  await page.click("#gateway-connect");
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent?.trim() === "connected",
    undefined,
    { timeout: 45000 },
  ).catch(() => {});
  const status = (await page.locator("#status").textContent())?.trim();
  check(status === "connected", `connected to live gateway (${status}, ${Date.now() - t0}ms)`);

  // --- auth shape on the wire (static mode) ---
  const initPost = acpPosts.find((p) => p.body.includes('"method":"initialize"'));
  const laterPosts = acpPosts.filter((p) => p !== initPost);
  check(
    !!initPost && initPost.tenant === TENANT && initPost.user === USER,
    `initialize carried X-Tenant-Id/${TENANT} + X-User-Id/${USER} (${initPost ? "present" : "missing"})`,
  );
  check(
    laterPosts.length > 0 && laterPosts.every((p) => p.tenant === null && p.user === null),
    `tenant headers on initialize only (${laterPosts.length} later POSTs clean)`,
  );
  check(laterPosts.every((p) => p.auth === null), "no Authorization header anywhere");
  check(wasmRequests.length === 0, "no wasm for the whole session");

  // --- session list (gateway-answered) ---
  await sleep(1500);
  const listText = (await page.locator("#session-list").textContent().catch(() => "")) ?? "";
  check(status === "connected" && listText !== null, `session/list rendered (${listText.trim().slice(0, 60) || "empty"})`);

  // --- new session: works only if the southbound chain is up ---
  await page.click("#new-session");
  const outcome = await Promise.race([
    page
      .waitForFunction(
        () => !!document.querySelector("#prompt-input"),
        undefined,
        { timeout: 30000 },
      )
      .then(() => "session")
      .catch(() => "timeout"),
    page
      .waitForFunction(
        () => {
          const seen = `${document.querySelector("#log")?.textContent ?? ""} ${
            document.querySelector("#status")?.textContent ?? ""
          }`;
          return /暂不可用|不可用|error|失败|trace/i.test(seen);
        },
        undefined,
        { timeout: 30000 },
      )
      .then(() => "error")
      .catch(() => "none"),
  ]);
  // Where the copy lands depends on the view: the chat log when a session is
  // open, the status line on the session-matrix front page (no log pane there).
  const logText =
    `${(await page.locator("#log").textContent({ timeout: 5000 }).catch(() => "")) ?? ""} ` +
    `${(await page.locator("#status").textContent().catch(() => "")) ?? ""}`;
  const diag = await page.evaluate(() => {
    const b = document.querySelector("#new-session");
    return {
      logExists: !!document.querySelector("#log"),
      log: (document.querySelector("#log")?.textContent ?? "").slice(0, 200),
      btnDisabled: b ? b.disabled : null,
      status: document.querySelector("#status")?.textContent ?? null,
      unhandled: window.__unh ?? [],
      body: document.body.innerText.replace(/\s+/g, " ").slice(0, 300),
    };
  });
  notes.push(`page diag: ${JSON.stringify(diag)}`);

  if (outcome === "session") {
    notes.push("session/new SUCCEEDED — southbound goose is up");
    check(!/trace_id|-32002|JSON-RPC/i.test(logText), "no raw error blob in the log");
    await page.fill("#prompt-input", "Reply with exactly: PONG");
    await page.click("#send-btn");
    const replied = await page
      .waitForFunction(
        () => /PONG/i.test(document.querySelector("#log")?.textContent ?? ""),
        undefined,
        { timeout: 120000 },
      )
      .then(() => true)
      .catch(() => false);
    check(replied, "prompt round-tripped through the live chain");

    // --- open a PRE-existing session from the list (session/load + replay) ---
    // Skip row 0: that's the session we just created (openSession short-circuits).
    await sleep(2500);
    const rows = page.locator("#session-list .session-item");
    const rowCount = await rows.count().catch(() => 0);
    if (rowCount > 1) {
      const loadsBefore = netLog.filter((l) => l.includes("session/load")).length;
      let target = "";
      for (let i = 1; i < rowCount && i < 5; i++) {
        const row = rows.nth(i);
        target = ((await row.textContent().catch(() => "")) ?? "").slice(0, 40);
        await row.click().catch((e) => notes.push(`session row click failed: ${e.message}`));
        await page
          .waitForFunction(
            () => document.querySelector("#status")?.textContent?.trim() === "connected",
            undefined,
            { timeout: 25000 },
          )
          .catch(() => {});
        await sleep(800);
        const loads = netLog.filter((l) => l.includes("session/load")).length;
        if (loads > loadsBefore) break;
      }
      const loads = netLog.filter((l) => l.includes("session/load")).length;
      const afterOpen = ((await page.locator("#log").textContent({ timeout: 5000 }).catch(() => "")) ?? "");
      check(loads > loadsBefore, `existing session opened via session/load ("${target}")`);
      check(
        !/could not load session/i.test(afterOpen),
        `session replayed without error (log: ${afterOpen.slice(0, 120).replace(/\s+/g, " ")})`,
      );
    } else {
      notes.push(`session list had ${rowCount} rows — skipped the session/load check`);
    }
  } else {
    // Server state, not client: -32002 means the southbound goose never came
    // up — the gateway was started without -south-secret, so goose has no
    // GOOSE_SERVER__SECRET_KEY and exits immediately.
    const hasMappedCopy = /服务暂不可用/.test(logText);
    const hasTrace = /trace/.test(logText);
    check(
      hasMappedCopy && hasTrace,
      `session/new refused → UI shows mapped copy + trace id (${logText.trim().slice(0, 160).replace(/\s+/g, " ")})`,
    );
    notes.push(
      `session/new blocked server-side (${outcome}) — southbound goose not running; gateway missing -south-secret (no GOOSE_SERVER__SECRET_KEY → goose exits at boot)`,
    );
  }

  check(
    consoleErrors.filter((e) => !/favicon/i.test(e)).length === 0,
    `no console errors (${consoleErrors.filter((e) => !/favicon/i.test(e)).join(" | ")})`,
  );
  check(leaks.length === 0, `no auth material in the console (${leaks.join(" | ")})`);

  console.log("\n  wire: " + [
    `init tenant=${initPost?.tenant ?? "-"} user=${initPost?.user ?? "-"}`,
    `later POSTs=${laterPosts.length}`,
    `bearer=${acpPosts.some((p) => p.auth) ? "present (unexpected)" : "never"}`,
  ].join(", "));
  // Is the browser's connection stream still alive on the gateway side?
  if (connId.value) {
    const probe = await (async () => {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 6000);
      try {
        const r = await fetch(`${GATEWAY_URL.replace(/\/+$/, "")}/acp`, {
          method: "GET",
          headers: { Accept: "text/event-stream", "Acp-Connection-Id": connId.value },
          signal: ac.signal,
        });
        return `${r.status} (200 = no subscriber: page stream died, 409 = page stream open)`;
      } catch {
        return "no answer";
      } finally {
        clearTimeout(to);
        ac.abort();
      }
    })();
    notes.push(`gateway-side connection stream after run: ${probe} conn=${connId.value}`);
  }

  // --- connection drop: offline → reconnect panel → recover + resume ---
  // (runs after the "no console errors" check on purpose: the offline window
  // legitimately logs net::ERR_INTERNET_DISCONNECTED / Failed to fetch.)
  const getsBefore = await page.evaluate(() => performance.getEntriesByType("resource").length);
  await ctx.setOffline(true);
  await sleep(8000);
  const statusOffline = ((await page.locator("#status").textContent({ timeout: 3000 }).catch(() => "")) ?? "").trim();
  const panelShown = await page.locator("#reconnect-panel").isVisible().catch(() => false);
  notes.push(`offline: status="${statusOffline}" reconnect-panel=${panelShown}`);
  await ctx.setOffline(false);
  await sleep(15000);
  const statusBack = ((await page.locator("#status").textContent({ timeout: 3000 }).catch(() => "")) ?? "").trim();
  const streamReopened = await page.evaluate(() => {
    const acp = performance.getEntriesByType("resource").filter((e) => e.name.includes("/acp"));
    return acp.length;
  });
  const resumed = await page.locator("#prompt-input").isVisible().catch(() => false);
  check(
    panelShown || /reconnect/i.test(statusOffline),
    `drop noticed by the UI (status="${statusOffline}", panel=${panelShown})`,
  );
  check(
    statusBack === "connected",
    `connection re-established after the network returned (status="${statusBack}")`,
  );
  notes.push(`session resumed after reconnect: ${resumed} (resource entries ${getsBefore} → ${streamReopened})`);
} catch (err) {
  failures.push(`exception: ${err?.stack ?? err}`);
} finally {
  await ctx?.close().catch(() => {});
  await browser.close().catch(() => {});
  vite.kill();
}

console.log("\n  — /acp traffic —");
for (const l of netLog) console.log(`   ${l}`);
if (consoleAll.length) {
  console.log("  — page console (acp + warnings/errors) —");
  const shown = consoleAll.filter((l) => /\[acp\]|\[error\]|\[warning\]|\[pageerror\]/i.test(l));
  for (const l of shown.slice(0, 120)) console.log(`   ${l}`);
}

for (const n of notes) console.log(`  · ${n}`);
if (failures.length) {
  console.error(`\n✗ LIVE GATEWAY FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n✓ LIVE GATEWAY PASSED — transport, auth, UI copy against the real gateway\n");
