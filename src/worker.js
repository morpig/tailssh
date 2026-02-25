/**
 * Cloudflare Worker entry point for TailSSH.
 *
 * Routes:
 *   GET /api/healthz   — liveness check
 *   GET /api/devices   — proxy to Tailscale API, returns trimmed device list
 *   *                  — static assets from /public
 *
 * The Tailscale API token is stored as a Worker secret named TS_API_TOKEN.
 * It never reaches the browser.  Set it with:
 *   npx wrangler secret put TS_API_TOKEN          (production)
 *   echo "TS_API_TOKEN=tskey-api-…" >> .dev.vars  (local dev)
 */

const TAILSCALE_API = "https://api.tailscale.com/api/v2";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/healthz") {
      return json({ ok: true });
    }

    if (url.pathname === "/api/devices") {
      return handleDevices(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

/**
 * Proxy GET /api/devices → Tailscale API.
 *
 * Returns a JSON array of trimmed device objects:
 *   { id, name, hostname, addresses, os, online, lastSeen, sshEnabled }
 *
 * The token is read from the TS_API_TOKEN secret binding.  "tailnet/-" means
 * "the tailnet that owns this token" — no need to hard-code the tailnet name.
 */
async function handleDevices(request, env) {
  if (!env.TS_API_TOKEN) {
    return json(
      { error: "TS_API_TOKEN secret is not configured. See src/worker.js for instructions." },
      { status: 500 }
    );
  }

  // Only allow GET
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  let resp;
  try {
    resp = await fetch(`${TAILSCALE_API}/tailnet/-/devices?fields=all`, {
      headers: {
        Authorization: `Bearer ${env.TS_API_TOKEN}`,
        "User-Agent": "tailssh-worker/1.0",
      },
    });
  } catch (err) {
    return json({ error: `Tailscale API unreachable: ${err.message}` }, { status: 502 });
  }

  if (!resp.ok) {
    return json(
      { error: `Tailscale API returned ${resp.status}` },
      { status: resp.status === 401 || resp.status === 403 ? resp.status : 502 }
    );
  }

  const data = await resp.json();

  // Trim to only the fields the frontend needs
  const now = Date.now();
  const devices = (data.devices ?? []).flatMap((d) => {
    // Guard: skip devices with no name — d.name.split(".") would throw
    if (!d.name) return [];

    // The Tailscale REST API does not return an `online` field.
    // Infer it from lastSeen: if the device checked in within the last
    // 10 minutes it is considered online (same threshold the admin UI uses).
    const lastSeenMs = d.lastSeen ? new Date(d.lastSeen).getTime() : 0;
    const online = lastSeenMs > 0 && (now - lastSeenMs) < 10 * 60 * 1000;

    return [{
      id:          d.id,
      name:        d.name,                        // full MagicDNS FQDN e.g. "jkt02-mvn-1.taila58d0.ts.net"
      displayName: d.name.split(".")[0],           // unique short label  e.g. "jkt02-mvn-1"
      hostname:    d.hostname ?? "",               // OS hostname (may be non-unique)
      addresses:   d.addresses ?? [],
      os:          d.os ?? "",
      online,
      lastSeen:    d.lastSeen ?? null,
      sshEnabled:  d.sshEnabled ?? false,
    }];
  });

  return json(devices, {
    // Short cache so repeated opens are snappy but not stale
    headers: { "Cache-Control": "no-store" },
  });
}

function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}
