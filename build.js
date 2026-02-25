#!/usr/bin/env node
/**
 * build.js — Vendor required assets from node_modules into /public
 *
 * Files produced in /public
 * ──────────────────────────
 *  pkg.js           @tailscale/connect ESM bundle
 *                   (includes xterm.js, FitAddon, WebLinksAddon, wasm_exec shim,
 *                    and the createIPN / runSSHSession exports)
 *  main.wasm        Go WASM binary — the Tailscale node itself
 *  xterm.css        xterm.js stylesheet (from @xterm/xterm)
 *
 * Why a custom build script?
 * ──────────────────────────
 * • main.wasm (~32 MB) must remain a separate file so the browser can use
 *   WebAssembly.instantiateStreaming() — bundling it into JS would prevent
 *   streaming compilation and exceed size limits.
 * • pkg.js from @tailscale/connect is already a self-contained ESM bundle;
 *   re-bundling it would break its internal WASM path resolution.
 * • Cloudflare Workers Static Assets serves files from /public automatically
 *   with correct MIME types, caching, and global CDN distribution.
 *
 * Run:  node build.js   (or: npm run build)
 */

import { copyFileSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const PUBLIC  = resolve("public");

// ─── Helper ──────────────────────────────────────────────────────────────────

function copy(src, dest) {
  if (!existsSync(src)) {
    console.error(`  ✗  not found: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, dest);
  console.log(`  ✓  ${dest.replace(process.cwd() + "/", "")}`);
}

function pkgRoot(pkg) {
  return resolve(require.resolve(`${pkg}/package.json`), "..");
}

// ─── @tailscale/connect ───────────────────────────────────────────────────────

console.log("\nCopying @tailscale/connect …");
const tsDir = pkgRoot("@tailscale/connect");

console.log("  package contents:", readdirSync(tsDir).join(", "));

// pkg.js — self-contained ESM bundle (xterm + wasm_exec + createIPN + runSSHSession)
copy(join(tsDir, "pkg.js"),   join(PUBLIC, "pkg.js"));

// main.wasm — the Go Tailscale WASM binary
// pkg.js fetches it at runtime from "./main.wasm" (relative to pkg.js)
copy(join(tsDir, "main.wasm"), join(PUBLIC, "main.wasm"));

// ─── pkg.css ─────────────────────────────────────────────────────────────────
// @tailscale/connect ships pkg.css which contains xterm CSS + Tailwind.
// We serve it alongside pkg.js.

copy(join(tsDir, "pkg.css"), join(PUBLIC, "pkg.css"));

// ─── Done ────────────────────────────────────────────────────────────────────

console.log("\nBuild complete.  Public assets:\n");
readdirSync(PUBLIC).sort().forEach((f) => console.log(`  /public/${f}`));
console.log();
