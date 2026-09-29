// React entry for the roam web client.
//
// Reuses goose's reference clients, vendored under src/vendor/:
//  - @aaif/goose-sdk (vendor/goose-sdk): GooseClient over the roam byte-duplex
//    or straight into a goose-gateway over ACP Streamable HTTP
//  - @desktop (vendor/desktop): desktop components (MarkdownContent,
//    ToolCallStatusIndicator, Button) + the desktop Tailwind theme
//
// Two transports, one entry: a direct gateway target boots without the iroh
// wasm at all (it is only imported once a `goose+roam://` card shows up), and
// a gateway-only build (VITE_GATEWAY_ONLY=1) never bundles it.
import "./shim";
import "./theme.css";
// CRITICAL: the desktop's main.css only *registers* token names for Tailwind;
// the actual color values are applied at runtime by applyThemeTokens() (the
// desktop calls this in renderer.tsx before first paint). Without it every
// semantic token (--color-text-primary, …) is undefined and the UI renders
// washed out. It's browser-safe: localStorage + matchMedia only.
import { applyThemeTokens, getResolvedTheme } from "@desktop/theme/theme-tokens";
import React from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { App } from "./App";
import { HOST_CARD_KEY, loadHosts } from "./hosts";
import {
  gatewayRoamClient,
  isGatewayOnlyBoot,
  wrapRoamClient,
  type RoamLike,
} from "./gateway";
import { completeLogin } from "./sso";

const SECRET_STORAGE_KEY = "goose-roam-secret-hex";

declare const __GATEWAY_ONLY__: boolean;

// A gateway-only *build* drops the wasm chunk from the bundle entirely.
const gatewayOnlyBuild =
  typeof __GATEWAY_ONLY__ !== "undefined" ? __GATEWAY_ONLY__ : false;

// Load the iroh wasm transport (glue + .wasm, lazily split out of the main
// chunk). Cached, so boot and the first user-initiated load share one fetch.
// The gateway-only branch is chosen statically, so the bundler sees the
// dynamic import as unreachable and drops the wasm chunk from that build.
let roamPromise: Promise<RoamLike> | null = null;
const loadRoam: () => Promise<RoamLike> = gatewayOnlyBuild
  ? () => Promise.reject(new Error("gateway-only build: no roam transport"))
  : () => {
      if (!roamPromise) {
        roamPromise = (async () => {
          const { default: initWasm, RoamClient } = await import(
            "./wasm/goose_roaming_web.js"
          );
          await initWasm();
          // Stable per-browser roam identity so the host only accepts this tab once.
          const saved = localStorage.getItem(SECRET_STORAGE_KEY) ?? undefined;
          const client = new RoamClient(saved);
          if (!saved) localStorage.setItem(SECRET_STORAGE_KEY, client.secretHex());
          return wrapRoamClient(client);
        })();
      }
      return roamPromise;
    };

// ?gateway=1 forces the gateway branch on a first visit (otherwise a visitor
// with an empty localStorage would download the wasm before ever seeing the
// URL field).
function wantsGatewayBoot(): boolean {
  return /[?&]gateway=1/.test(location.search) || /[?&#]gateway=1/.test(location.hash);
}

async function boot() {
  // Apply the desktop theme (token values + .dark class) before first paint,
  // exactly like the desktop's renderer.tsx + ThemeContext do.
  const resolved = getResolvedTheme();
  applyThemeTokens(resolved);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", (e) => {
      const t = e.matches ? "dark" : "light";
      applyThemeTokens(t);
      document.documentElement.classList.toggle("dark", t === "dark");
    });

  // Logto sends the browser back to <origin>/callback. Finish the code
  // exchange — and the org-scoped refresh that makes the gateway accept the
  // token (see sso.ts) — *before* the first render, so the app boots with the
  // token in the gateway form instead of racing it against a remembered host's
  // auto-connect. /callback itself is an SPA route: the server falls back to
  // index.html for it.
  let ssoError: string | null = null;
  if (/^\/callback\/?$/.test(location.pathname)) {
    try {
      await completeLogin();
    } catch (err) {
      ssoError = err instanceof Error ? err.message : String(err);
    }
  }

  const gatewayOnlyBoot =
    gatewayOnlyBuild ||
    wantsGatewayBoot() ||
    isGatewayOnlyBoot(loadHosts(), localStorage.getItem(HOST_CARD_KEY));
  const roam = gatewayOnlyBoot ? gatewayRoamClient() : await loadRoam();

  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <IntlProvider locale="en" defaultLocale="en" messages={{}}>
        <App
          roam={roam}
          loadRoam={gatewayOnlyBuild ? null : loadRoam}
          bootNotice={ssoError}
        />
      </IntlProvider>
    </React.StrictMode>,
  );
}

void boot();
