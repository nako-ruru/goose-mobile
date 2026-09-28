// Acceptance ⑤ (docs/gateway-integration-tasks.md §9): the SHIPPED artifact —
// `dist/` from `vite build`, no dev server, no dev proxy — behind a same-origin
// reverse proxy that forwards /acp with streaming, which is what production
// needs (nginx `proxy_buffering off`; a buffering proxy stalls the gateway's
// SSE headers, see README "CORS / hosting"). Verified in a real browser:
//
//   1. the page is served from dist/ (hashed /assets/index-*.js, no /@vite/)
//   2. gateway mode + blank gateway URL = same-origin /acp
//   3. connect → tenant headers on initialize only, GET stream through the proxy
//   4. new session + a prompt round-trip (streamed result arrives over /acp)
//   5. no wasm, no auth material, no real console errors
//
//   node tests/dist-proxy.mjs                       # mock gateway (self-contained)
//   GOOSE_GATEWAY_URL=http://192.168.3.19:7731 TENANT=t1 USER_ID=u1 \
//     node tests/dist-proxy.mjs                     # live stack
//   SKIP_BUILD=1 node tests/dist-proxy.mjs          # reuse ./dist
import http from "node:http";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { startGatewayMock } from "./gateway-mock.mjs";

const PROXY_PORT = 5221;
const MOCK_PORT = 13401;
const BASE = `http://localhost:${PROXY_PORT}`;
const DIST = path.resolve("dist");
const LIVE = process.env.GOOSE_GATEWAY_URL ?? "";
const failures = [];
const notes = [];
const log = (...a) => console.log("  ", ...a);
const check = (cond, msg) => (cond ? log(`✓ ${msg}`) : failures.push(msg));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
};

function build() {
  if (process.env.SKIP_BUILD) return;
  log("building dist/ …");
  const res = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
    stdio: "inherit",
    env: process.env,
  });
  if ((res.status ?? 1) !== 0) throw new Error(`vite build failed (${res.status})`);
}

// Same-origin reverse proxy. /acp is forwarded byte-for-byte and the response
// is flushed as soon as the upstream headers land — never buffered, which is
// exactly nginx's `proxy_buffering off` for /acp. Everything else comes from
// dist/ (SPA fallback to index.html).
function startProxy(target) {
  const targetUrl = new URL(target);
  const mod = targetUrl.protocol === "https:" ? https : http;
  const acpLog = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname === "/acp") {
      acpLog.push(`${req.method} ${url.pathname}`);
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      const upstream = mod.request(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
          path: "/acp",
          method: req.method,
          headers: { ...headers, host: targetUrl.host },
        },
        (up) => {
          const rh = { ...up.headers };
          delete rh.connection;
          delete rh["keep-alive"];
          // Let Node frame the body itself; SSE has no content-length.
          delete rh["transfer-encoding"];
          res.writeHead(up.statusCode ?? 502, rh);
          res.flushHeaders(); // headers now — do not wait for the first frame
          up.pipe(res);
        },
      );
      upstream.on("error", (err) => {
        acpLog.push(`upstream error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end(`proxy: ${err.message}`);
        } else {
          res.destroy();
        }
      });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
      return;
    }

    // static dist/
    let rel = decodeURIComponent(url.pathname);
    if (rel.includes("..")) {
      res.writeHead(400);
      res.end();
      return;
    }
    if (rel === "/") rel = "/index.html";
    let file = path.join(DIST, rel);
    if (!file.startsWith(DIST)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (path.extname(rel)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      file = path.join(DIST, "index.html"); // SPA fallback
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": file.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    });
    createReadStream(file).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(PROXY_PORT, "127.0.0.1", () => resolve({ server, acpLog }));
  });
}

async function main() {
  build();
  if (!existsSync(path.join(DIST, "index.html"))) {
    throw new Error("dist/index.html missing — run without SKIP_BUILD");
  }

  let mock = null;
  let target;
  if (LIVE) {
    target = LIVE.replace(/\/acp\/?$/, "");
    notes.push(`target: live gateway ${target}`);
  } else {
    mock = await startGatewayMock({ port: MOCK_PORT, mode: "static" });
    target = `http://127.0.0.1:${MOCK_PORT}`;
    notes.push(`target: gateway mock ${target}`);
  }

  const { server, acpLog } = await startProxy(target);
  notes.push(`proxy: ${BASE} → ${target}/acp (streaming), dist/ elsewhere`);

  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleErrors = [];
  const leaks = [];
  const requests = [];
  const wasmRequests = [];
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error") consoleErrors.push(t);
    if (/authorization|bearer|x-tenant-id|x-user-id/i.test(t)) leaks.push(t);
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("request", (r) => {
    const u = r.url();
    requests.push(u);
    if (/\.wasm(\?|$)/.test(u)) wasmRequests.push(u);
  });

  try {
    console.log("\n— acceptance ⑤: dist/ behind a same-origin /acp proxy —");
    await page.goto(`${BASE}/?gateway=1`, { waitUntil: "domcontentloaded" });
    await page.locator("#gateway-url").waitFor({ state: "visible", timeout: 30000 });

    check(
      requests.some((u) => /\/assets\/index-[\w-]+\.js(\?|$)/.test(u)),
      "page boots from the built bundle (hashed /assets/index-*.js)",
    );
    check(
      !requests.some((u) => u.includes("/@vite/") || u.includes("@react-refresh")),
      "no dev-server requests (/@vite/, react refresh)",
    );
    check(wasmRequests.length === 0, "gateway mode fetched no wasm");
    check(
      (await page.locator("#mode-gateway").getAttribute("aria-pressed")) === "true",
      "gateway mode preselected (?gateway=1)",
    );
    check(
      (await page.locator("#gateway-url").inputValue()) === "",
      "gateway URL blank = same origin /acp",
    );

    if (LIVE) {
      await page.fill("#gateway-tenant", process.env.TENANT ?? "t1");
      await page.fill("#gateway-user", process.env.USER_ID ?? "u1");
    } else {
      await page.fill("#gateway-tenant", "t1");
      await page.fill("#gateway-user", "u1");
    }
    await page.click("#gateway-connect");
    const connected = await page
      .waitForFunction(
        () => document.querySelector("#status")?.textContent?.trim() === "connected",
        undefined,
        { timeout: 45000 },
      )
      .then(() => true)
      .catch(() => false);
    check(connected, "connected through the reverse proxy (SSE GET opened)");

    const opened = await page
      .click("#matrix-new-session")
      .then(() =>
        page.waitForFunction(() => !!document.querySelector("#prompt-input"), undefined, {
          timeout: 30000,
        }),
      )
      .then(() => true)
      .catch(() => false);
    check(opened, "session opened (session/new over the proxy)");

    const reply = LIVE ? /PONG/i : "hello from the mock gateway";
    await page.fill("#prompt-input", LIVE ? "Reply with exactly: PONG" : "hello there");
    await page.click("#send-btn");
    const gotReply = await page
      .waitForFunction(
        (needle) =>
          typeof needle === "string"
            ? (document.querySelector("#log")?.textContent ?? "").includes(needle)
            : /PONG/i.test(document.querySelector("#log")?.textContent ?? ""),
        reply,
        { timeout: LIVE ? 120000 : 20000 },
      )
      .then(() => true)
      .catch(() => false);
    check(gotReply, `prompt round-tripped through the proxy (${String(reply)})`);

    check(acpLog.length >= 4, `/acp forwarded (${acpLog.length} requests: ${[...new Set(acpLog)].join(", ")})`);
    check(leaks.length === 0, `no auth material in the console (${leaks.join(" | ")})`);
    const realErrors = consoleErrors.filter(
      (e) => !/favicon/i.test(e) && !/Error handling request/.test(e),
    );
    check(realErrors.length === 0, `no console errors (${realErrors.join(" | ")})`);
  } catch (err) {
    failures.push(`exception: ${err?.stack ?? err}`);
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    server.closeAllConnections?.();
    server.close();
    await mock?.close();
  }

  console.log("\n  — proxy /acp log —");
  for (const l of acpLog) console.log(`   ${l}`);
  for (const n of notes) console.log(`  · ${n}`);
  if (failures.length) {
    console.error(`\n✗ DIST PROXY FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\n✓ DIST PROXY PASSED — built artifact + streaming reverse proxy\n");
}

await main();
