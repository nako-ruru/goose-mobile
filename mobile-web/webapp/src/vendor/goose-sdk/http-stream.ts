import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

const ACP_CONNECTION_HEADER = "Acp-Connection-Id";
const ACP_SESSION_HEADER = "Acp-Session-Id";

/**
 * Northbound auth for a direct `goose-gateway` target (`-auth static|jwt`).
 * Keys are the stream's base URL ("" = same origin), so one browser tab can
 * hold several gateways at once.
 */
export type AcpGatewayAuth = {
  mode: "static" | "jwt";
  tenantId?: string;
  userId?: string;
  token?: string;
};

const gatewayAuth = new Map<string, AcpGatewayAuth>();

/** Register (or clear, with `null`) the auth headers for one gateway base. */
export function registerAcpGatewayAuth(
  baseUrl: string,
  auth: AcpGatewayAuth | null,
): void {
  const key = baseUrl.replace(/\/+$/, "");
  if (auth) gatewayAuth.set(key, auth);
  else gatewayAuth.delete(key);
}

/**
 * Headers for one request, per the gateway's two auth modes:
 * `-auth static` puts the tenant/user headers on `initialize` only (the
 * gateway binds identity to the connection id there and authenticates the
 * connection afterwards), `-auth jwt` puts `Authorization: Bearer` on every
 * request. Never logged.
 */
function authHeaders(base: string, phase: "initialize" | "request"): Record<string, string> {
  const auth = gatewayAuth.get(base);
  if (!auth) return {};
  if (auth.mode === "jwt") {
    return auth.token ? { Authorization: `Bearer ${auth.token}` } : {};
  }
  if (phase !== "initialize") return {};
  const headers: Record<string, string> = {};
  if (auth.tenantId) headers["X-Tenant-Id"] = auth.tenantId;
  if (auth.userId) headers["X-User-Id"] = auth.userId;
  return headers;
}

function acpDebug(label: string, payload: unknown): void {
  const g = globalThis as {
    ACP_DEBUG?: unknown;
    localStorage?: { getItem?: (k: string) => string | null };
    process?: { env?: Record<string, string | undefined> };
  };
  const on =
    g.ACP_DEBUG === true ||
    g.ACP_DEBUG === "1" ||
    !!g.localStorage?.getItem?.("ACP_DEBUG") ||
    !!g.process?.env?.ACP_DEBUG;
  if (!on) return;
  // eslint-disable-next-line no-console
  console.debug(`[acp] ${label}`, payload);
}

const SESSION_SCOPED_METHODS = new Set<string>([
  "session/prompt",
  "session/cancel",
  "session/load",
  "session/set_mode",
  "session/set_model",
]);

function messageMethod(msg: AnyMessage): string | null {
  const m = msg as { method?: unknown };
  return typeof m.method === "string" ? m.method : null;
}

function messageParams(msg: AnyMessage): unknown {
  return (msg as { params?: unknown }).params;
}

function messageResult(msg: AnyMessage): unknown {
  return (msg as { result?: unknown }).result;
}

function isRequest(msg: AnyMessage): boolean {
  const m = msg as { method?: unknown; id?: unknown };
  return typeof m.method === "string" && m.id !== undefined && m.id !== null;
}

function isNotification(msg: AnyMessage): boolean {
  const m = msg as { method?: unknown; id?: unknown };
  return typeof m.method === "string" && (m.id === undefined || m.id === null);
}

function isResponse(msg: AnyMessage): boolean {
  const m = msg as { method?: unknown; id?: unknown; result?: unknown; error?: unknown };
  return (
    m.method === undefined &&
    m.id !== undefined &&
    m.id !== null &&
    (m.result !== undefined || m.error !== undefined)
  );
}

function extractSessionId(value: unknown): string | null {
  if (value && typeof value === "object" && "sessionId" in value) {
    const sid = (value as { sessionId?: unknown }).sessionId;
    if (typeof sid === "string") return sid;
  }
  return null;
}

/**
 * Stream that speaks the ACP Streamable HTTP transport: a connection-scoped
 * GET SSE stream plus a session-scoped stream per active `sessionId`.
 */
export function createHttpStream(serverUrl: string): Stream {
  // A relative base ("", same origin) resolves against the *document* path, so
  // a build served under a path prefix (GitHub Pages project site) still hits
  // its own reverse proxy; an absolute base is used verbatim.
  const base = serverUrl.replace(/\/+$/, "");
  const endpoint = base ? `${base}/acp` : "acp";

  let connectionId: string | null = null;
  let connectionStreamAbort: AbortController | null = null;
  const sessionStreamAborts = new Map<string, AbortController>();
  const openSessionStreams = new Set<string>();
  let closed = false;

  const inbox: AnyMessage[] = [];
  let pullResolve: (() => void) | null = null;

  // A response can beat our own write: the gateway pushes the answer on the
  // SSE stream while this POST is still awaiting its 202. The SDK only binds
  // its handler to the pending request once the write settles, so an error
  // delivered in that window (a -32001/-32601 answer) is reported to the page
  // as an unhandled rejection. Hold each response until the write for that id
  // has settled; successes are unaffected, errors stop being noisy.
  const inflightWrites = new Map<number, Promise<void>>();

  function deliver(msg: AnyMessage) {
    acpDebug("deliver → sdk", msg);
    inbox.push(msg);
    if (pullResolve) {
      const r = pullResolve;
      pullResolve = null;
      r();
    }
  }

  function waitForInbox(): Promise<void> {
    if (inbox.length > 0) return Promise.resolve();
    return new Promise<void>((r) => {
      pullResolve = r;
    });
  }

  async function openConnectionGetStream() {
    if (!connectionId) return;
    connectionStreamAbort = new AbortController();

    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        [ACP_CONNECTION_HEADER]: connectionId,
        ...authHeaders(base, "request"),
      },
      signal: connectionStreamAbort.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `Failed to open ACP connection-scoped GET stream: ${response.status} ${response.statusText}`,
      );
    }

    void consumeSSE(response.body, "connection").catch((err) => {
      if (closed) return;
      // eslint-disable-next-line no-console
      console.error("ACP connection-scoped GET stream error:", err);
    });
  }

  async function ensureSessionGetStream(sessionId: string): Promise<void> {
    if (!connectionId) return;
    if (openSessionStreams.has(sessionId)) return;
    openSessionStreams.add(sessionId);

    const abort = new AbortController();
    sessionStreamAborts.set(sessionId, abort);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          [ACP_CONNECTION_HEADER]: connectionId,
          [ACP_SESSION_HEADER]: sessionId,
          ...authHeaders(base, "request"),
        },
        signal: abort.signal,
      });
    } catch (e) {
      openSessionStreams.delete(sessionId);
      sessionStreamAborts.delete(sessionId);
      throw e;
    }

    if (!response.ok || !response.body) {
      openSessionStreams.delete(sessionId);
      sessionStreamAborts.delete(sessionId);
      throw new Error(
        `Failed to open ACP session-scoped GET stream for ${sessionId}: ${response.status} ${response.statusText}`,
      );
    }

    acpDebug("session GET stream open", { sessionId });
    void consumeSSE(response.body, `session:${sessionId}`)
      .catch((err) => {
        if (closed) return;
        // eslint-disable-next-line no-console
        console.error(
          `ACP session-scoped GET stream error (${sessionId}):`,
          err,
        );
      })
      .finally(() => {
        if (sessionStreamAborts.get(sessionId) === abort) {
          sessionStreamAborts.delete(sessionId);
          openSessionStreams.delete(sessionId);
          acpDebug("session GET stream closed", { sessionId });
        }
      });
  }

  async function consumeSSE(body: ReadableStream<Uint8Array>, label: string) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleSseEvent(event, label);
        }
      }
      if (buffer.length > 0) handleSseEvent(buffer, label);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      throw e;
    }
  }

  function handleSseEvent(event: string, label: string) {
    const dataLines: string[] = [];
    for (const line of event.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    let msg: AnyMessage;
    try {
      msg = JSON.parse(data) as AnyMessage;
    } catch {
      return;
    }

    acpDebug(`SSE → client (${label})`, msg);
    handleInbound(msg);
  }

  function handleInbound(msg: AnyMessage) {
    if (isResponse(msg)) {
      const rid = (msg as { id?: unknown }).id;
      const pending = typeof rid === "number" ? inflightWrites.get(rid) : undefined;
      if (pending) {
        acpDebug("hold response for write", { id: rid });
        pending.then(
          () => deliver(msg),
          () => deliver(msg),
        );
        return;
      }
      const sid = extractSessionId(messageResult(msg));
      if (sid && !openSessionStreams.has(sid)) {
        ensureSessionGetStream(sid).catch((err) => {
          if (closed) return;
          // eslint-disable-next-line no-console
          console.error("Failed to open session GET stream:", err);
        });
      }
    }

    deliver(msg);
  }

  async function sendInitialize(msg: AnyMessage) {
    acpDebug("initialize → agent", msg);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...authHeaders(base, "initialize"),
      },
      body: JSON.stringify(msg),
    });

    if (!response.ok) {
      throw new Error(
        `ACP initialize failed: ${response.status} ${response.statusText}`,
      );
    }

    const connId = response.headers.get(ACP_CONNECTION_HEADER);
    if (!connId) {
      throw new Error(
        `ACP initialize response missing ${ACP_CONNECTION_HEADER} header`,
      );
    }
    connectionId = connId;

    const body = (await response.json()) as AnyMessage;
    acpDebug("initialize response", body);
    // Open the connection-scoped GET stream before delivering the initialize
    // response so we don't miss any immediate server-initiated messages.
    await openConnectionGetStream();
    deliver(body);
  }

  async function sendPost(msg: AnyMessage) {
    if (!connectionId) {
      throw new Error("ACP POST attempted before initialize");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      [ACP_CONNECTION_HEADER]: connectionId,
      ...authHeaders(base, "request"),
    };

    let outboundSessionId: string | null = null;
    if (isRequest(msg) || isNotification(msg)) {
      outboundSessionId = extractSessionId(messageParams(msg));
      if (outboundSessionId) {
        headers[ACP_SESSION_HEADER] = outboundSessionId;
      } else if (isRequest(msg)) {
        const method = messageMethod(msg);
        if (method && SESSION_SCOPED_METHODS.has(method)) {
          throw new Error(`ACP method ${method} requires sessionId in params`);
        }
      }
    }

    if (outboundSessionId && messageMethod(msg) !== "session/load") {
      try {
        await ensureSessionGetStream(outboundSessionId);
      } catch (err) {
        if (String(err).includes("409")) {
          // 409 = another viewer already owns this session's stream (the
          // gateway allows one subscriber per session). Our responses still
          // arrive on the connection-scoped stream, so this is normal for a
          // second device watching the same session — not an error.
          acpDebug("session stream busy (409) — riding the connection stream", {
            sessionId: outboundSessionId,
          });
        } else {
          // eslint-disable-next-line no-console
          console.error("Failed to ensure session GET stream:", err);
        }
      }
    }

    acpDebug("POST → agent", msg);
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(msg),
    });

    if (response.status !== 202 && !response.ok) {
      throw new Error(
        `ACP POST failed: ${response.status} ${response.statusText}`,
      );
    }
    await response.arrayBuffer().catch(() => undefined);
  }

  async function sendDelete() {
    if (!connectionId) return;
    try {
      await fetch(endpoint, {
        method: "DELETE",
        headers: {
          [ACP_CONNECTION_HEADER]: connectionId,
          ...authHeaders(base, "request"),
        },
      });
    } catch {
      // best-effort
    }
  }

  function abortAllStreams() {
    connectionStreamAbort?.abort();
    connectionStreamAbort = null;
    for (const a of sessionStreamAborts.values()) {
      a.abort();
    }
    sessionStreamAborts.clear();
    openSessionStreams.clear();
  }

  const readable = new ReadableStream<AnyMessage>({
    async pull(controller) {
      await waitForInbox();
      while (inbox.length > 0) {
        controller.enqueue(inbox.shift()!);
      }
      if (closed && inbox.length === 0) {
        controller.close();
      }
    },
    async cancel() {
      closed = true;
      await sendDelete();
      abortAllStreams();
      if (pullResolve) {
        const r = pullResolve;
        pullResolve = null;
        r();
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(msg) {
      const id = (msg as { id?: unknown }).id;
      const tracked = isRequest(msg) && typeof id === "number";
      let settle: () => void = () => {};
      if (tracked) {
        inflightWrites.set(
          id,
          new Promise<void>((r) => {
            settle = r;
          }),
        );
      }
      try {
        if (
          !connectionId &&
          isRequest(msg) &&
          messageMethod(msg) === "initialize"
        ) {
          await sendInitialize(msg);
          return;
        }
        if (!connectionId) {
          throw new Error(
            "ACP transport: first outgoing message must be `initialize`",
          );
        }
        await sendPost(msg);
      } finally {
        if (tracked) {
          acpDebug("write settled", { id });
          settle();
          inflightWrites.delete(id);
        }
      }
    },
    async close() {
      closed = true;
      await sendDelete();
      abortAllStreams();
      if (pullResolve) {
        const r = pullResolve;
        pullResolve = null;
        r();
      }
    },
    async abort() {
      closed = true;
      await sendDelete();
      abortAllStreams();
      if (pullResolve) {
        const r = pullResolve;
        pullResolve = null;
        r();
      }
    },
  });

  return { readable, writable };
}
