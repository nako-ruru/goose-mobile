// Logto SSO: turn a browser login into the access_token the gateway's
// `-auth jwt` verification accepts, and hand it to the existing
// Bearer-every-request path (zero changes in http-stream / gateway.ts).
//
// Why there is a ticket step at all: this Logto tenant will not mint a JWT
// access_token for a browser application. The authorization_code exchange
// returns an *opaque* token (43 chars, no payload) and the gateway only
// accepts JWTs — verified on real devices, and the console cannot grant
// resource/role access to non-M2M applications. So the app hands its Logto
// tokens to the same-origin ticket endpoint, which validates the session
// server-side (Logto /oidc/me) and mints the gateway JWT:
//
//   POST <origin>/token      {"access_token": <opaque>, "id_token": <id_token>}
//     200 {access_token, expires_in, subject, organization_id}
//     400 missing_access_token      401 invalid_session | id_token_mismatch
//     403 not_allowed | not_in_org  429 rate_limited
//
// Same-origin means no CORS and no secret in the browser: the password is
// typed on Logto's page, we only ever send client_id. The gateway ticket is
// short-lived, so a fresh one is minted whenever it is about to expire or the
// gateway answers 401 — no refresh_token flow is involved.
import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";

const AUTHORITY = "https://auth.logto.guanghe.co/oidc";
const CLIENT_ID = "3oqwvcn65cxviv0rvqpju";
/** Same-origin ticket endpoint (the dev server proxies it in vite.config.ts). */
const TICKET_PATH = "/token";

/** The gateway-ready ticket. Deliberately one entry: hosts.ts persists the auth
 *  a connect uses, and that is the platform login state — no second copy. */
export const SSO_TOKEN_KEY = "goose-sso-access-token";
/** The Logto tokens, kept only so a new ticket can be minted later. */
const IDP_ACCESS_KEY = "goose-sso-idp-access";
const IDP_ID_KEY = "goose-sso-idp-id";
const TICKET_EXP_KEY = "goose-sso-ticket-exp";

function isLoginCallback(): boolean {
  return /^\/callback\/?$/.test(location.pathname);
}

/** The one redirect URI registered for this client, derived from the origin. */
export function redirectUri(): string {
  return `${location.origin}/callback`;
}

let manager: UserManager | null = null;

function userManager(): UserManager {
  if (!manager) {
    manager = new UserManager({
      authority: AUTHORITY,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: "code",
      // urn:logto:scope:organizations is not needed for the ticket exchange
      // (the broker validates the session), but it keeps the id_token's
      // organization claim available for the sub/org cross-check.
      scope: "openid profile email offline_access urn:logto:scope:organizations",
      stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    });
  }
  return manager;
}

/** Hand the browser to Logto's authorize endpoint. */
export async function beginLogin(): Promise<void> {
  await userManager().signinRedirect();
}

/**
 * Copy for a refused ticket. A pure function of the status + documented error
 * code: no token material, no raw response body (the gateway-side copy rules in
 * docs/gateway-integration-tasks.md §6 apply here too).
 */
function ticketErrorText(status: number, body: unknown): string {
  const code = typeof (body as { error?: unknown } | null)?.error === "string"
    ? ((body as { error: string }).error)
    : typeof (body as { code?: unknown } | null)?.code === "string"
      ? ((body as { code: string }).code)
      : "";
  const sub = (body as { sub?: unknown } | null)?.sub;
  const withSub = typeof sub === "string" && sub ? `（sub: ${sub}）` : "";
  switch (code) {
    case "missing_access_token":
      return "取票失败：请求里没有 access_token";
    case "invalid_session":
      return "登录态无效或已过期，请重新登录";
    case "id_token_mismatch":
      return "id_token 与 access_token 不是同一个登录态，请重新登录";
    case "not_allowed":
      return `该账号未开通白名单${withSub}`;
    case "not_in_org":
      return `该账号不在 goose-test 组织内${withSub}`;
    case "rate_limited":
      return "取票过于频繁，请稍后再试";
    default:
      return `取票失败（HTTP ${status}${code ? ` / ${code}` : ""}）`;
  }
}

type TicketResponse = {
  access_token?: string;
  expires_in?: number;
  subject?: string;
  organization_id?: string;
};

/** Mint (or re-mint) a gateway ticket from the Logto tokens. */
async function mintTicket(idpAccess: string, idpId?: string): Promise<string> {
  const res = await fetch(`${location.origin}${TICKET_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: idpAccess,
      ...(idpId ? { id_token: idpId } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(ticketErrorText(res.status, body));
  }
  const json = (await res.json()) as TicketResponse;
  if (!json.access_token) throw new Error("取票失败：响应里没有 access_token");
  // Renew slightly early so a connect never races the expiry.
  const ttl = json.expires_in ?? 3600;
  localStorage.setItem(TICKET_EXP_KEY, String(Math.floor(Date.now() / 1000) + ttl - 60));
  localStorage.setItem(SSO_TOKEN_KEY, json.access_token);
  return json.access_token;
}

/**
 * Finish the round trip on `/callback`: exchange the code, then swap the Logto
 * tokens for a gateway ticket. Returns the ticket, or null when this page load
 * is not a callback at all.
 */
export async function completeLogin(): Promise<string | null> {
  if (!isLoginCallback()) return null;
  const user = await userManager().signinCallback();
  if (!user) throw new Error("登录回调没有返回用户信息（state 不匹配或已被使用）");
  if (!user.access_token) throw new Error("登录未返回 access_token");
  localStorage.setItem(IDP_ACCESS_KEY, user.access_token);
  if (user.id_token) localStorage.setItem(IDP_ID_KEY, user.id_token);
  const ticket = await mintTicket(user.access_token, user.id_token ?? undefined);
  // Drop the code/state from the address bar before the app boots.
  window.history.replaceState(null, "", location.pathname.replace(/\/callback\/?$/, "") || "/");
  return ticket;
}

/** A previously issued gateway ticket, if this browser still has one. */
export function savedToken(): string | null {
  try {
    return localStorage.getItem(SSO_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** True when there is no Logto session left to re-mint from. */
function hasIdpSession(): boolean {
  try {
    return !!localStorage.getItem(IDP_ACCESS_KEY);
  } catch {
    return false;
  }
}

/** The stored ticket is within the renewal margin (or its expiry is unknown). */
export function ticketStale(): boolean {
  try {
    const exp = Number(localStorage.getItem(TICKET_EXP_KEY) ?? "0");
    return !exp || exp <= Math.floor(Date.now() / 1000) + 30;
  } catch {
    return true;
  }
}

/**
 * Mint a fresh gateway ticket from the stored Logto tokens. Returns null when
 * this browser has no Logto session (e.g. a ticket pasted by hand), so callers
 * can fall back to whatever token they already hold.
 */
export async function renewTicket(): Promise<string | null> {
  if (!hasIdpSession()) return null;
  const idpAccess = localStorage.getItem(IDP_ACCESS_KEY) ?? "";
  return mintTicket(idpAccess, localStorage.getItem(IDP_ID_KEY) ?? undefined);
}

/** Forget the login (ticket + Logto tokens). */
export function clearLogin(): void {
  for (const k of [SSO_TOKEN_KEY, IDP_ACCESS_KEY, IDP_ID_KEY, TICKET_EXP_KEY]) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* private mode */
    }
  }
}
