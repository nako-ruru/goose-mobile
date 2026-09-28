// A stand-in for goose-gateway's *northbound* transport
// (goose-gateway/internal/transport/http.go), so the web client's gateway path
// can be exercised without the Go binary:
//
//   POST /acp  initialize -> 200 + Acp-Connection-Id (auth checked here)
//   POST /acp  anything   -> 202, response follows on the connection SSE
//   POST /acp  no method  -> an ask/elicitation reply (recorded, 202)
//   POST /acp  session/prompt containing "slow" -> held open until the
//               client's session/cancel arrives, then answered "cancelled"
//   GET  /acp  connection  -> SSE stream (responses, server pushes)
//   GET  /acp  session     -> SSE stream for that session's notifications
//   DELETE     /acp        -> closes
//
// Auth matches the gateway's two modes: `-auth static` checks X-Tenant-Id /
// X-User-Id on initialize only (identity is bound to the connection id after
// that), `-auth jwt` checks `Authorization: Bearer` on *every* request. Every
// observation lands in `observations` so the test can assert the client never
// sends tenant headers anywhere but initialize, never logs them, and answers
// reverse requests with -32601 instead of hanging.
//
// Run standalone:  node tests/gateway-mock.mjs   (listens on 13399)
import http from "node:http";

const NOW = () => new Date().toISOString();

function jsonRpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

export function startGatewayMock({
  port = 13399,
  mode = "static",
  tenant = "t1",
  token = "tok-abc",
} = {}) {
  const observations = []; // { phase, path, tenant, bearer, ok }
  const askReplies = []; // frames the client POSTed back (no method)
  const framesSent = [];
  const conns = new Map();
  let seq = 0;
  // Stable across calls: the client's 6s "who else is touching this session"
  // poll treats a moving updatedAt as a foreign run.
  const STABLE_UPDATED_AT = NOW();

  const record = (phase, req, ok, extra = {}) => {
    observations.push({
      phase,
      tenant: req.headers["x-tenant-id"] ?? null,
      user: req.headers["x-user-id"] ?? null,
      bearer: req.headers.authorization ?? null,
      conn: req.headers["acp-connection-id"] ?? null,
      session: req.headers["acp-session-id"] ?? null,
      ok,
      ...extra,
    });
  };

  const authorized = (req) =>
    mode === "jwt"
      ? req.headers.authorization === `Bearer ${token}`
      : true; // static binds identity at initialize; later requests ride the conn id

  function writeSse(res, frame) {
    framesSent.push(frame);
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }

  function push(conn, frame) {
    if (frame.params?.sessionId && conn.sessionSse?.has(frame.params.sessionId)) {
      writeSse(conn.sessionSse.get(frame.params.sessionId), frame);
      return;
    }
    if (conn.sse) writeSse(conn.sse, frame);
    else conn.queue.push(frame);
  }

  function flush(conn) {
    if (!conn.sse) return;
    while (conn.queue.length) writeSse(conn.sse, conn.queue.shift());
  }

  // Route one client -> gateway request, per the rules the real gateway
  // applies (PASS / gateway-answered / -32601).
  function route(frame, conn) {
    const p = frame.params ?? {};
    switch (frame.method) {
      case "session/new":
        return jsonRpc(frame.id, {
          sessionId: "s_1",
          mcpServers: [],
          permissionMode: "default",
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              currentValue: "mock-a",
              options: [
                { value: "mock-a", name: "Mock A" },
                { value: "mock-b", name: "Mock B" },
              ],
            },
          ],
        });
      case "session/list":
        // Gateway-answered: filtered to this tenant's sessions.
        return jsonRpc(frame.id, {
          sessions: [
            {
              sessionId: "s_1",
              title: "tenant t1 session",
              updatedAt: STABLE_UPDATED_AT,
              mcpServers: [],
              permissionMode: "default",
            },
          ],
        });
      case "session/load":
        return jsonRpc(frame.id, { messages: [], mcpServers: [] });
      case "session/cancel": {
        // A held turn resolves the way a real one does: the pending prompt
        // response comes back as {stopReason:"cancelled"} once cancel lands.
        const held = conn.pendingPrompt;
        if (held) {
          conn.pendingPrompt = null;
          setTimeout(() => push(conn, jsonRpc(held.id, { stopReason: "cancelled" })), 5);
        }
        return jsonRpc(frame.id, {});
      }
      case "session/set_mode":
      case "session/set_config_option":
        return jsonRpc(frame.id, {
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              currentValue: p.value ?? "mock-a",
              options: [
                { value: "mock-a", name: "Mock A" },
                { value: "mock-b", name: "Mock B" },
              ],
            },
          ],
        });
      case "_goose/unstable/session/steer":
        return jsonRpc(frame.id, {});
      case "session/prompt": {
        const text = JSON.stringify(p.prompt ?? "");
        if (text.includes("busy")) {
          return jsonRpcError(frame.id, -32001, "busy", { quota: 0 });
        }
        if (text.includes("unavail")) {
          return jsonRpcError(frame.id, -32002, "unavailable", { trace_id: "tr_mock_9" });
        }
        if (text.includes("slow")) {
          // Hold the turn open until the client's session/cancel arrives, so
          // the stop button has something to interrupt.
          conn.pendingPrompt = frame;
          return null;
        }
        // Stream a reply as notifications first, then the response frame —
        // exactly how a real turn interleaves.
        push(conn, {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: p.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from the mock gateway" } },
          },
        });
        push(conn, {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: p.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
          },
        });
        return jsonRpc(frame.id, { stopReason: "end_turn" });
      }
      case "_goose/unstable/sources/list":
        // The gateway has no ownership route for it: always -32601, and the
        // UI must degrade silently.
        return jsonRpcError(frame.id, -32601, "Method not found");
      default:
        return jsonRpcError(frame.id, -32601, "Method not found");
    }
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    const wantSse = req.headers.accept?.includes("text/event-stream");

    if (req.method === "GET") {
      const isSession = !!req.headers["acp-session-id"];
      const conn = conns.get(req.headers["acp-connection-id"]);
      if (!conn) {
        record("get", req, false, { note: "no connection" });
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("unknown or missing Acp-Connection-Id");
      }
      if (!authorized(req)) {
        record("get", req, false);
        res.writeHead(401, { "Content-Type": "text/plain" });
        return res.end("unauthorized");
      }
      record("get", req, true, { stream: isSession ? "session" : "connection" });
      if (!isSession && conn.sse) {
        // One subscriber per connection, like the gateway.
        res.writeHead(409, { "Content-Type": "text/plain" });
        return res.end("connection stream already open");
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // Headers only, no first frame — exactly what the real gateway does.
      // An initial `: ok` here would hide a proxy that fails to flush upstream
      // headers until the first body byte (the bug that only showed up against
      // the live gateway), so flush explicitly like Go does instead.
      res.flushHeaders();
      if (isSession) {
        conn.sessionSse ??= new Map();
        conn.sessionSse.set(req.headers["acp-session-id"], res);
        res.on("close", () => conn.sessionSse.delete(req.headers["acp-session-id"]));
      } else {
        conn.sse = res;
        res.on("close", () => {
          if (conn.sse === res) conn.sse = null;
        });
        flush(conn);
      }
      return;
    }

    if (req.method === "DELETE") {
      const conn = conns.get(req.headers["acp-connection-id"]);
      record("delete", req, !!conn);
      conn?.sse?.end();
      res.writeHead(204);
      return res.end();
    }

    if (req.method !== "POST") {
      res.writeHead(405);
      return res.end();
    }

    let frame;
    try {
      frame = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("bad json-rpc frame");
    }

    if (frame.method === "initialize") {
      const tenantOk =
        mode === "jwt"
          ? req.headers.authorization === `Bearer ${token}`
          : req.headers["x-tenant-id"] === tenant;
      record("initialize", req, tenantOk);
      if (!tenantOk) {
        res.writeHead(401, { "Content-Type": "text/plain", "WWW-Authenticate": 'Bearer realm="goose-gateway"' });
        return res.end("unauthorized");
      }
      const id = `c_${++seq}`;
      const conn = { id, queue: [], sse: null, sessionSse: new Map(), reverseSent: false };
      conns.set(id, conn);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Acp-Connection-Id": id,
      });
      res.end(
        JSON.stringify(
          jsonRpc(frame.id, {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
          }),
        ),
      );
      return;
    }

    const conn = conns.get(req.headers["acp-connection-id"]);
    if (!conn) {
      record("post", req, false, { note: "no connection", method: frame.method });
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("unknown or missing Acp-Connection-Id");
    }
    if (!authorized(req)) {
      record("post", req, false, { method: frame.method });
      res.writeHead(401, { "Content-Type": "text/plain" });
      return res.end("unauthorized");
    }

    if (frame.method === undefined) {
      // Ask/elicitation reply: {id, result|error}, no method.
      record("post", req, true, { kind: "ask-reply", id: frame.id });
      askReplies.push(frame);
      res.writeHead(202);
      return res.end();
    }

    record("post", req, true, { method: frame.method, params: frame.params, id: frame.id });
    res.writeHead(202);
    res.end();
    // Reverse requests once a session exists: the client must refuse them
    // (-32601), not leave them pending. 4242 is a real ACP method the client
    // has no UI for (SDK default), 4243 an extension method (our default).
    // Deliberately not pushed at initialize: the connection stream then stays
    // headers-only like the real gateway, so a dev proxy that fails to flush
    // proxied headers until the first body byte hangs connect and this test
    // fails instead of sliding through on a stray frame.
    if (frame.method === "session/new" && !conn.reverseSent) {
      conn.reverseSent = true;
      setTimeout(() => {
        push(conn, {
          jsonrpc: "2.0",
          id: 4242,
          method: "terminal/create",
          params: { command: "echo hi", sessionId: "s_1", cwd: "/" },
        });
        push(conn, {
          jsonrpc: "2.0",
          id: 4243,
          method: "_goose/unstable/form/ask",
          params: { sessionId: "s_1" },
        });
      }, 250);
    }
    setTimeout(() => {
      const out = route(frame, conn);
      // Notifications (session/cancel …) have no id: route() still runs for
      // its side effects, but ACP forbids answering them with a frame.
      if (out && frame.id !== undefined) push(conn, out);
    }, 5);
    return;
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port,
        server,
        observations,
        askReplies,
        framesSent,
        close: () =>
          new Promise((r) => {
            for (const c of conns.values()) c.sse?.end();
            server.close(r);
          }),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const mode = process.argv.includes("--jwt") ? "jwt" : "static";
  const mock = await startGatewayMock({ mode });
  console.log(`gateway mock listening on http://127.0.0.1:${mock.port} (-auth ${mode})`);
}
