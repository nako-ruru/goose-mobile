// Direct-gateway targets: URL normalization, stable ids, the northbound auth
// config, and the JSON-RPC error-code → UI text map (§6 of
// docs/gateway-integration-tasks.md).
//
// A gateway target is identified the same way a roam host is — by the string
// the user pasted ("card"), except that it is a gateway base URL instead of a
// `goose+roam://` card. It rides the existing hosts table, so restore /
// reconnect / multi-host merging all keep working unchanged.
//
// The gateway never leaks its internal error strings northbound: we only ever
// see the five codes in gwerr (/-32601, -32602, -32001, -32002, -32003/), so
// the UI copy is a pure function of the code.
import type { AcpGatewayAuth } from "@aaif/goose-sdk";
import { cardEndpointHint } from "./hosts";
import type { RoamClient, RoamConnection } from "./wasm/goose_roaming_web.js";

export type GatewayAuth = AcpGatewayAuth;

export const ROAM_CARD_PREFIX = "goose+roam://";

/** True when the target is a roam card (P2P) rather than a gateway URL. */
export function isRoamCard(text: string): boolean {
  return text.trim().startsWith(ROAM_CARD_PREFIX);
}

/**
 * Canonicalize a gateway base URL: trim, drop a trailing `/acp` (the client
 * appends it) and trailing slashes. `""` and `"/"` both mean *same origin*
 * — the dev vite proxy and a production reverse proxy both forward `/acp`,
 * which is what makes the no-CORS gateway usable from a browser at all.
 */
export function normalizeGatewayUrl(raw: string): string {
  let t = raw.trim();
  if (!t) return "/";
  t = t.replace(/\/+$/, "");
  if (/\/acp$/i.test(t)) t = t.slice(0, -4).replace(/\/+$/, "");
  return t || "/";
}

/** The URL prefix `http-stream` appends `/acp` to ("" = same origin). */
export function gatewayBaseUrl(raw: string): string {
  const n = normalizeGatewayUrl(raw);
  return n === "/" ? "" : n;
}

/** A stable per-origin key, so a same-origin gateway keeps its host id. */
function gatewayKey(raw: string): string {
  const base = gatewayBaseUrl(raw);
  if (base) return base;
  return typeof location !== "undefined" ? location.origin : "same-origin";
}

/**
 * Stable endpoint id for a gateway target (`gw-<hash>`), the analogue of a
 * roam endpoint id: keys the session list, the last-session memory and the
 * saved-host row across reloads.
 */
export function gatewayEndpointId(raw: string): string {
  const key = gatewayKey(raw);
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return `gw-${h.toString(16).padStart(8, "0")}`;
}

/** Human label for a gateway target (no secrets, no path noise). */
export function gatewayLabel(raw: string): string {
  const base = gatewayBaseUrl(raw);
  if (!base) {
    return typeof location !== "undefined" ? location.host || "same origin" : "same origin";
  }
  return base.replace(/^https?:\/\//, "");
}

// ---------------------------------------------------------------------------
// Roam transport facade
// ---------------------------------------------------------------------------

/**
 * The slice of the wasm `RoamClient` the UI touches. `kind` says which
 * transport is loaded: the gateway path never instantiates iroh wasm, so a
 * gateway-only boot hands App a stub (`kind: "gateway"`) and the 3.8 MB wasm
 * chunk stays unloaded until the user actually wants a P2P host.
 */
export type RoamLike = {
  kind: "roam" | "gateway";
  myCard(): string;
  endpointId(): string;
  connect(cardText: string, label?: string | null): Promise<RoamConnection>;
};

export function wrapRoamClient(client: RoamClient): RoamLike {
  return {
    kind: "roam",
    myCard: () => client.myCard(),
    endpointId: () => client.endpointId(),
    connect: (cardText, label) => client.connect(cardText, label),
  };
}

/** Placeholder transport for a gateway-only boot: never dials anything. */
export function gatewayRoamClient(): RoamLike {
  const fail = () => {
    throw new Error("gateway target: the roam transport is not loaded");
  };
  return {
    kind: "gateway",
    myCard: () => "(direct gateway — pairing not used)",
    endpointId: () => "gateway",
    connect: fail,
  };
}

// ---------------------------------------------------------------------------
// Error copy
// ---------------------------------------------------------------------------

type RpcErr = { code?: unknown; data?: unknown };

function rpcCode(err: unknown): number | null {
  const code = (err as RpcErr | null)?.code;
  return typeof code === "number" ? code : null;
}

function traceOf(err: unknown): string | null {
  const data = (err as RpcErr | null)?.data;
  if (typeof data === "string" && data) return data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const t = d["trace_id"] ?? d["traceId"] ?? d["trace"];
    if (typeof t === "string" && t) return t;
  }
  // Some paths only ever carry the trace id in the message.
  const m = String((err as Error | null)?.message ?? "").match(/trace[_ ]id[=: ]+([A-Za-z0-9._-]+)/i);
  return m ? m[1] : null;
}

/**
 * Map a gateway JSON-RPC error to UI copy. Returns `null` when the error is
 * not a gateway-shaped RPC error, so callers fall back to the raw string
 * (transport failures, validation errors, …).
 */
export function gatewayErrorText(err: unknown): string | null {
  const trace = traceOf(err);
  switch (rpcCode(err)) {
    case -32601:
      return "该操作不可用";
    case -32602:
      return "参数被忽略（服务端已清洗）";
    case -32001:
      return "会话忙，请稍后重试";
    case -32002:
      return trace ? `服务暂不可用（trace: ${trace}）` : "服务暂不可用，请稍后重试";
    case -32003:
      return trace ? `服务内部错误（trace: ${trace}）` : "服务内部错误";
    default:
      return null;
  }
}

/** Copy for a failed *dial* (before any JSON-RPC exchange exists). */
export function connectErrorText(err: unknown): string {
  const s = String(err);
  if (/401|unauthorized/i.test(s)) {
    return "gateway 拒绝了认证（401）—— 检查 tenant/user 头或 token";
  }
  if (/Failed to fetch|NetworkError|Load failed|CORS/i.test(s)) {
    return `连不上 gateway（网络/跨域）：${s} —— 网关没有 CORS，开发期请填同源 URL 走 vite proxy，生产用同域反代`;
  }
  return gatewayErrorText(err) ?? s;
}

/** UI copy for any ACP error: gateway codes first, raw message otherwise. */
export function errorText(err: unknown): string {
  return gatewayErrorText(err) ?? String(err);
}

// ---------------------------------------------------------------------------
// Connect form
// ---------------------------------------------------------------------------

/** The add-host gateway form (raw strings — validation happens on submit). */
export type GatewayForm = {
  url: string;
  mode: "static" | "jwt";
  tenantId: string;
  userId: string;
  token: string;
};

export const DEFAULT_GATEWAY_FORM: GatewayForm = {
  url: "",
  mode: "static",
  tenantId: "",
  userId: "",
  token: "",
};

/** Form → wire auth. Blank fields are omitted so the headers stay minimal. */
export function gatewayAuthFromForm(form: GatewayForm): GatewayAuth {
  if (form.mode === "jwt") {
    return { mode: "jwt", token: form.token.trim() };
  }
  return {
    mode: "static",
    tenantId: form.tenantId.trim() || undefined,
    userId: form.userId.trim() || undefined,
  };
}

// ---------------------------------------------------------------------------
// Boot state
// ---------------------------------------------------------------------------

/** Endpoint id for *any* target (roam card or gateway URL), for retries. */
export function targetEndpointHint(text: string): string | null {
  return isRoamCard(text) ? cardEndpointHint(text) : gatewayEndpointId(text);
}

/**
 * True when the browser has only ever used gateway targets (and no roam card
 * is remembered): main.tsx then skips `initWasm()` entirely, so the gateway
 * path never pays for — or even fetches — the iroh wasm.
 */
export function isGatewayOnlyBoot(hosts: { card: string }[], lastCard: string | null): boolean {
  if (lastCard && isRoamCard(lastCard)) return false;
  if (hosts.length === 0) return !!lastCard; // remembered gateway url, no rows yet
  return hosts.every((h) => !isRoamCard(h.card));
}
