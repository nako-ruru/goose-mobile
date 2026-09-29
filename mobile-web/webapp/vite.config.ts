import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// This app reuses goose's reference clients, vendored under src/vendor/:
//  - @aaif/goose-sdk (vendor/goose-sdk): GooseClient — protocol/transport layer
//  - @desktop (vendor/desktop): desktop components (MarkdownContent,
//    ToolCallStatusIndicator, …) imported as source; @vitejs/plugin-react
//    compiles their JSX, tailwind scans them for classes (via theme.css),
//    and a tiny window.electron shim covers the desktop-only APIs.
const gooseSdk = fileURLToPath(
  new URL("./src/vendor/goose-sdk/index.ts", import.meta.url),
);
const desktopSrc = fileURLToPath(
  new URL("./src/vendor/desktop", import.meta.url),
);

const buildStamp = `${new Date().toISOString().slice(0, 16).replace("T", " ")}Z`;

// goose-gateway answers on /acp and serves no CORS headers at all (M1 scope),
// so dev traffic goes through the same-origin vite proxy below. Override the
// southbound gateway with GOOSE_GATEWAY=http://host:13300.
const gatewayTarget = process.env.GOOSE_GATEWAY ?? "http://127.0.0.1:13300";

// VITE_GATEWAY_ONLY=1 builds without the iroh wasm chunk (pure gateway client).
const gatewayOnly =
  process.env.VITE_GATEWAY_ONLY === "1" || process.env.VITE_GATEWAY_ONLY === "true";

export default defineConfig({
  root: ".",
  // The desktop pairing QR points at a GitHub Pages *project* site
  // (https://aaif-goose.github.io/goose-mobile/), so assets must resolve
  // relative to index.html, not the domain root.
  base: "./",
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp),
    __GATEWAY_ONLY__: JSON.stringify(gatewayOnly),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@aaif/goose-sdk": gooseSdk,
      "@desktop": desktopSrc,
    },
    // One shared copy across app + SDK + desktop sources.
    dedupe: ["react", "react-dom", "@agentclientprotocol/sdk", "zod", "react-intl"],
  },
  server: {
    port: 5178,
    proxy: {
      // Same-origin /acp in dev; the client's blank gateway URL means exactly
      // this. The gateway's SSE GET sends headers and then nothing until the
      // first frame, and node only flushes proxied headers on the first body
      // byte — so we take the response over ourselves (selfHandleResponse) and
      // flush immediately. Without that, the stream GET hangs forever.
      "/acp": {
        target: gatewayTarget,
        changeOrigin: true,
        selfHandleResponse: true,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            if (res.headersSent || res.writableEnded || res.destroyed) return;
            // Dead upstream or a client that hung up mid-stream must not raise
            // an unhandled error inside the manual pipe below.
            proxyRes.on("error", () => res.destroy());
            res.on("error", () => proxyRes.destroy());
            const headers: Record<string, string> = { ...proxyRes.headers };
            delete headers["transfer-encoding"];
            delete headers.connection;
            delete headers["keep-alive"];
            try {
              res.writeHead(proxyRes.statusCode, headers);
              res.flushHeaders();
              proxyRes.pipe(res);
            } catch {
              proxyRes.resume();
              res.destroy();
            }
          });
        },
      },
    },
  },
  build: {
    target: "esnext",
    outDir: "dist",
  },
  // Production serves the built app through a reverse proxy (Caddy) that keeps
  // the public Host header. Vite's preview blocks unknown Host values, so the
  // production name has to be allow-listed here or every request 403s with
  // "This host is not allowed" before a byte of the app is served.
  preview: {
    allowedHosts: ["agent.guanghe.co"],
  },
  assetsInclude: ["**/*.wasm"],
});
