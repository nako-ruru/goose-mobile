// The connect/hosts panel: saved-host rows, the add-host form with QR scan,
// the direct-gateway branch, onboarding copy, and the pairing card. Purely
// presentational — all state and actions live in App and arrive as props.
import type { RefObject } from "react";
import { Camera, ChevronLeft, ChevronRight } from "lucide-react";
import { Goose } from "@desktop/components/icons/Goose";
import type { SavedHost } from "./hosts";
import type { GatewayAuth, GatewayForm, RoamLike } from "./gateway";

type ConnectPanelProps = {
  hosts: SavedHost[];
  addingHost: boolean;
  connected: boolean;
  busy: boolean;
  card: string;
  hostName: string;
  canScan: boolean;
  pairOpen: boolean;
  scanning: boolean;
  myCard: string;
  myId: string;
  isHostLive: (endpointId: string) => boolean;
  setShowHosts: (v: boolean) => void;
  setAddingHost: (v: boolean) => void;
  setCard: (v: string) => void;
  setHostName: (v: string) => void;
  setPairOpen: (v: boolean) => void;
  connect: (targetText?: string, gatewayAuth?: GatewayAuth) => Promise<void>;
  startScan: () => Promise<void>;
  stopScan: () => void;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Which add-host form is showing: a roam card or a gateway URL. */
  addMode: "roam" | "gateway";
  setAddMode: (m: "roam" | "gateway") => void;
  gateway: GatewayForm;
  setGateway: (patch: Partial<GatewayForm>) => void;
  connectGateway: () => Promise<void>;
  /** Kick off the Logto SSO round trip (this tab leaves for the IdP). */
  ssoLogin: () => void;
  /** A token is sitting in the form (logged in or pasted) — connect can use it. */
  ssoReady: boolean;
  /** The iroh transport is loaded (or can be loaded on demand). */
  p2pLoaded: boolean;
  enableP2P: (() => Promise<RoamLike>) | null;
};

const modeCls = (on: boolean) =>
  `flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
    on
      ? "bg-background-primary text-text-primary shadow-sm font-medium"
      : "text-text-tertiary hover:text-text-primary"
  }`;

export function ConnectPanel({
  hosts,
  addingHost,
  connected,
  busy,
  card,
  hostName,
  canScan,
  pairOpen,
  scanning,
  myCard,
  myId,
  isHostLive,
  setShowHosts,
  setAddingHost,
  setCard,
  setHostName,
  setPairOpen,
  connect,
  startScan,
  stopScan,
  videoRef,
  addMode,
  setAddMode,
  gateway,
  setGateway,
  connectGateway,
  ssoLogin,
  ssoReady,
  p2pLoaded,
  enableP2P,
}: ConnectPanelProps) {
  return (
        <section id="connect-panel" className="flex-1 grid place-items-center p-3 md:p-6 overflow-auto bg-background-secondary">
          <div className="w-full max-w-[480px] min-w-0 overflow-hidden bg-background-primary rounded-xl shadow-sm p-6 md:p-8">
            {hosts.length > 0 && !addingHost ? (
              <>
                <div className="flex items-center gap-2 mb-1">
                  {connected && (
                    <button
                      aria-label="back to sessions"
                      className="text-text-secondary hover:text-text-primary -ml-1 p-0.5"
                      onClick={() => setShowHosts(false)}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                  )}
                  <h2 className="text-lg font-semibold">Your hosts</h2>
                </div>
                <p className="text-xs text-text-tertiary mb-4">
                  {connected
                    ? "connected hosts share one session list — tap to add another"
                    : "tap to connect"}
                </p>
                <div className="flex flex-col gap-1.5">
                  {hosts.map((h) => {
                    const live = isHostLive(h.endpointId);
                    return (
                    <button
                      key={h.endpointId}
                      className="host-row w-full text-left rounded-lg px-3 py-2.5 hover:bg-background-secondary transition-colors flex items-center gap-3 disabled:opacity-50"
                      disabled={busy || live}
                      onClick={() => {
                        setCard(h.card);
                        void connect(h.card);
                      }}
                    >
                      <Goose className="w-4 h-4 shrink-0 opacity-70" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium truncate">{h.name}</span>
                        <span className="block text-[10px] text-text-tertiary font-mono truncate">
                          {h.endpointId.slice(0, 16)}
                        </span>
                      </span>
                      {live ? (
                        <span className="shrink-0 inline-flex items-center gap-1 text-[10px] text-text-success">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-current" />
                          connected
                        </span>
                      ) : (
                        <ChevronRight className="w-4 h-4 shrink-0 text-text-tertiary" />
                      )}
                    </button>
                  );})}
                </div>
                <div className="mt-4 flex justify-center">
                  <button
                    id="add-host"
                    className="text-xs text-text-secondary rounded-lg px-3 py-1.5 hover:bg-background-secondary hover:text-text-primary transition-colors"
                    onClick={() => setAddingHost(true)}
                  >
                    add another host
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-1">
                  {hosts.length > 0 && (
                    <button
                      aria-label="back to hosts"
                      className="text-text-secondary hover:text-text-primary -ml-1 p-0.5"
                      onClick={() => setAddingHost(false)}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                  )}
                  <h2 className="text-lg font-semibold">
                    {hosts.length === 0 ? "goose remote" : "Add a host"}
                  </h2>
                </div>
                {(p2pLoaded || enableP2P) && (
                  <div className="flex gap-1 p-1 bg-background-secondary rounded-lg mb-3" role="tablist">
                    <button
                      id="mode-roam"
                      type="button"
                      aria-pressed={addMode === "roam"}
                      className={modeCls(addMode === "roam")}
                      onClick={() => setAddMode("roam")}
                    >
                      roam card
                    </button>
                    <button
                      id="mode-gateway"
                      type="button"
                      aria-pressed={addMode === "gateway"}
                      className={modeCls(addMode === "gateway")}
                      onClick={() => setAddMode("gateway")}
                    >
                      gateway
                    </button>
                  </div>
                )}
                {addMode === "gateway" ? (
                  <div className="text-xs text-text-secondary leading-relaxed mb-5 space-y-2">
                    <p>
                      Connect straight to a <code className="font-mono">goose-gateway</code> — one
                      URL plus tenant/token, no pairing, no relay.
                    </p>
                    <ol className="list-decimal ml-4 space-y-0.5 text-text-tertiary">
                      <li>
                        run it:{" "}
                        <code className="font-mono">goose-gateway -auth static</code> (or{" "}
                        <code className="font-mono">-auth jwt</code>)
                      </li>
                      <li>
                        blank URL reaches it through this origin — the dev proxy in{" "}
                        <code className="font-mono">vite.config.ts</code> locally, a reverse proxy
                        in production (the gateway serves no CORS)
                      </li>
                    </ol>
                  </div>
                ) : hosts.length === 0 ? (
                  <div className="text-xs text-text-secondary leading-relaxed mb-5 space-y-2">
                    <p>
                      Chat with a goose agent on your own machine, from this browser —
                      peer to peer, no accounts, nothing in between.
                    </p>
                    <ol className="list-decimal ml-4 space-y-0.5 text-text-tertiary">
                      <li>
                        on your machine: <code className="font-mono">goose roam share --qr</code>
                      </li>
                      <li>scan or paste its card below</li>
                      <li>
                        accept this browser once:{" "}
                        <code className="font-mono">goose roam pair</code> (or{" "}
                        <code className="font-mono">peers accept</code>) with the card under
                        “first time?”
                      </li>
                    </ol>
                  </div>
                ) : (
                  <p className="text-xs text-text-tertiary mb-4">
                    a machine running <code className="font-mono">goose roam share</code>
                  </p>
                )}
                <input
                  id="host-name"
                  type="text"
                  className="w-full bg-background-secondary rounded-lg px-3 py-2 text-sm mb-2"
                  placeholder="name (optional) — e.g. laptop"
                  value={hostName}
                  onChange={(e) => setHostName(e.target.value)}
                />
                {addMode === "gateway" ? (
                  <>
                    <input
                      id="gateway-url"
                      type="text"
                      className="w-full bg-background-secondary rounded-lg px-3 py-2 text-sm font-mono mb-2"
                      placeholder="gateway URL — blank = same origin"
                      value={gateway.url}
                      onChange={(e) => setGateway({ url: e.target.value })}
                    />
                    <label
                      htmlFor="gateway-auth"
                      className="block text-xs text-text-tertiary mb-1"
                    >
                      auth mode
                    </label>
                    <select
                      id="gateway-auth"
                      className="w-full bg-background-secondary rounded-lg px-3 py-2 text-sm mb-2"
                      value={gateway.mode}
                      onChange={(e) => setGateway({ mode: e.target.value as "static" | "jwt" })}
                    >
                      <option value="static">static — X-Tenant-Id / X-User-Id on initialize</option>
                      <option value="jwt">jwt — Authorization: Bearer on every request</option>
                    </select>
                    {gateway.mode === "static" ? (
                      <div className="flex gap-2 mb-2">
                        <input
                          id="gateway-tenant"
                          type="text"
                          className="min-w-0 flex-1 bg-background-secondary rounded-lg px-3 py-2 text-sm font-mono"
                          placeholder="tenant id"
                          value={gateway.tenantId}
                          onChange={(e) => setGateway({ tenantId: e.target.value })}
                        />
                        <input
                          id="gateway-user"
                          type="text"
                          className="min-w-0 flex-1 bg-background-secondary rounded-lg px-3 py-2 text-sm font-mono"
                          placeholder="user id (optional)"
                          value={gateway.userId}
                          onChange={(e) => setGateway({ userId: e.target.value })}
                        />
                      </div>
                    ) : (
                      <>
                        <input
                          id="gateway-token"
                          type="password"
                          autoComplete="off"
                          className="w-full bg-background-secondary rounded-lg px-3 py-2 text-sm font-mono mb-2"
                          placeholder="jwt"
                          value={gateway.token}
                          onChange={(e) => setGateway({ token: e.target.value })}
                        />
                        <div className="flex items-center gap-2 mb-2">
                          <button
                            id="sso-login"
                            type="button"
                            onClick={ssoLogin}
                            className="text-text-secondary rounded-lg px-3 py-1.5 text-xs hover:bg-background-secondary hover:text-text-primary transition-colors"
                          >
                            sign in with Logto
                          </button>
                          {ssoReady && (
                            <span
                              id="sso-ready"
                              className="text-[10px] text-text-tertiary"
                            >
                              token ready — connect
                            </span>
                          )}
                        </div>
                      </>
                    )}
                    <div className="mt-2.5 flex items-center gap-2">
                      <span className="flex-1" />
                      <button
                        id="gateway-connect"
                        disabled={busy}
                        onClick={() => void connectGateway()}
                        className="bg-background-inverse text-text-inverse text-sm font-medium rounded-lg px-4 py-1.5 hover:brightness-110 disabled:opacity-50"
                      >
                        connect
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <textarea
                      id="card-input"
                      rows={3}
                      className="w-full bg-background-secondary rounded-lg px-3 py-2.5 text-sm font-mono resize-none"
                      placeholder="goose+roam://…  (the host's card)"
                      value={card}
                      onChange={(e) => setCard(e.target.value)}
                    />
                    <div className="mt-2.5 flex items-center gap-2">
                      {canScan && (
                        <button
                          id="scan-card"
                          type="button"
                          className="inline-flex items-center gap-1.5 text-text-secondary rounded-lg px-3 py-1.5 text-xs hover:bg-background-secondary hover:text-text-primary transition-colors"
                          onClick={() => void startScan()}
                        >
                          <Camera className="w-3.5 h-3.5" /> scan QR
                        </button>
                      )}
                      {!p2pLoaded && enableP2P && (
                        <button
                          id="load-p2p"
                          type="button"
                          className="text-text-tertiary rounded-lg px-3 py-1.5 text-xs hover:bg-background-secondary hover:text-text-primary transition-colors"
                          onClick={() => void enableP2P()}
                        >
                          load P2P transport
                        </button>
                      )}
                      <span className="flex-1" />
                      <button
                        id="connect-btn"
                        disabled={busy}
                        onClick={() => void connect()}
                        className="bg-background-inverse text-text-inverse text-sm font-medium rounded-lg px-4 py-1.5 hover:brightness-110 disabled:opacity-50"
                      >
                        connect
                      </button>
                    </div>
                  </>
                )}
                {addMode === "roam" && (
                <details
                  className="mt-6 pt-4 border-t border-border-primary"
                  open={pairOpen}
                  onToggle={(e) => setPairOpen((e.target as HTMLDetailsElement).open)}
                >
                  <summary className="text-xs text-text-secondary cursor-pointer select-none">
                    first time? pair this browser with the host
                  </summary>
                  <div className="mt-2.5 text-xs text-text-secondary leading-relaxed">
                    Send this browser's card to the host and accept it once:
                    <div className="flex gap-2 items-center my-2 min-w-0">
                      <code
                        id="my-card"
                        className="flex-1 min-w-0 font-mono text-[11px] bg-background-secondary rounded-lg px-2.5 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap"
                      >
                        {myCard}
                      </code>
                      <button
                        id="copy-card"
                        className="shrink-0 text-text-secondary rounded-lg px-2.5 py-1 text-xs hover:bg-background-secondary hover:text-text-primary transition-colors"
                        onClick={() => navigator.clipboard?.writeText(myCard)}
                      >
                        copy
                      </button>
                      {"share" in navigator && (
                        <button
                          id="share-card"
                          className="shrink-0 text-text-secondary rounded-lg px-2.5 py-1 text-xs hover:bg-background-secondary hover:text-text-primary transition-colors"
                          onClick={() => void navigator.share({ text: myCard }).catch(() => {})}
                        >
                          share
                        </button>
                      )}
                    </div>
                    <code className="block font-mono text-[11px] text-text-info bg-background-secondary rounded-lg px-2.5 py-2 break-all">
                      goose roam peers accept '&lt;card&gt;'
                    </code>
                    <div className="text-[10px] text-text-tertiary mt-1.5">
                      key <code id="my-endpoint-id" className="font-mono break-all">{myId}</code>
                    </div>
                  </div>
                </details>
                )}
              </>
            )}
          </div>
          {scanning && (
            <div
              className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center gap-3"
              onClick={() => stopScan()}
            >
              <video
                ref={videoRef}
                className="w-[90vw] max-w-[480px] rounded-xl"
                playsInline
                muted
              />
              <div className="text-white text-sm">point at the host QR — tap to cancel</div>
            </div>
          )}
        </section>
  );
}
