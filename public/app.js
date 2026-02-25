/**
 * TailSSH — Frontend entry point
 *
 * Architecture:
 *  - One Tailscale WASM node shared across all tabs
 *  - Each "tab" is an object { id, tabEl, paneEl, session, label }
 *  - A tab pane is either a picker (device list) or a live terminal
 *  - Tabs are drag-reorderable via HTML5 drag-and-drop
 *  - Closing a tab gracefully closes its SSH session first
 */

import { createIPN, runSSHSession } from "./pkg.js";

// ─── WASM environment patch ───────────────────────────────────────────────────
if (globalThis.fs) {
  globalThis.fs.cwd   = () => "/tmp";
  globalThis.fs.mkdir = (path, perm, cb) => { cb(null); };
}

// ─── DOM refs ────────────────────────────────────────────────────────────────
const loadingOverlay   = document.getElementById("loading-overlay");
const loadingText      = document.getElementById("loading-text");
const authOverlay      = document.getElementById("auth-overlay");
const authOpenBtn      = document.getElementById("auth-open-btn");
const authUrlHint      = document.getElementById("auth-url-hint");
const tsStatusBadge    = document.getElementById("ts-status");
const tsStatusText     = document.getElementById("ts-status-text");
const tabList          = document.getElementById("tab-list");
const newTabBtn        = document.getElementById("new-tab-btn");
const paneHost         = document.getElementById("pane-host");
const usernameModal    = document.getElementById("username-modal");
const usernameInput    = document.getElementById("username-input");
const usernameModalDesc= document.getElementById("username-modal-desc");
const usernameCancelBtn= document.getElementById("username-cancel-btn");
const usernameConnectBtn=document.getElementById("username-connect-btn");
const logoutBtn        = document.getElementById("logout-btn");

// ─── Global state ────────────────────────────────────────────────────────────
let pendingLoginURL = null;
let tabIdSeq = 0;
/** @type {Array<{id:number, tabEl:HTMLElement, paneEl:HTMLElement, session:object|null, label:string}>} */
const tabs = [];
let activeTabId = null;
/** @type {object|null} — set once Tailscale is Running */
let globalIpn = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setStatus(state) {
  const map = {
    NoState:          ["Initializing",  "status-connecting"],
    InUseOtherUser:   ["In Use",        "status-stopped"],
    NeedsLogin:       ["Needs Login",   "status-needsLogin"],
    NeedsMachineAuth: ["Needs Auth",    "status-needsLogin"],
    Stopped:          ["Stopped",       "status-stopped"],
    Starting:         ["Starting",      "status-connecting"],
    Running:          ["Connected",     "status-running"],
  };
  const [label, cls] = map[state] ?? ["Unknown", "status-connecting"];
  tsStatusBadge.className = `status-badge ${cls}`;
  tsStatusText.textContent = label;
  logoutBtn.hidden = (state !== "Running");
  if (state === "Running") {
    logoutBtn.disabled = false;
    logoutBtn.textContent = "Logout";
  }
}

const showLoading = (msg) => {
  loadingOverlay.classList.remove("hidden");
  loadingText.textContent = msg;
};
const hideLoading = () => loadingOverlay.classList.add("hidden");

const showAuthOverlay = (url) => {
  pendingLoginURL = url;
  // Safe assignment — url is a trusted server-provided string, not user content
  authUrlHint.textContent = url;
  authOverlay.classList.remove("hidden");
};
const hideAuthOverlay = () => authOverlay.classList.add("hidden");

function osIcon(os = "") {
  const o = os.toLowerCase();
  if (o.includes("linux"))                       return "🐧";
  if (o.includes("darwin") || o.includes("mac")) return "🍎";
  if (o.includes("windows"))                     return "🪟";
  if (o.includes("android"))                     return "🤖";
  if (o.includes("ios"))                         return "📱";
  return "💻";
}

function relativeTime(iso) {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── localStorage username persistence ───────────────────────────────────────

const LS_PREFIX = "tailssh:user:";

function getStoredUser(hostname) {
  try { return localStorage.getItem(LS_PREFIX + hostname) ?? ""; } catch { return ""; }
}

function setStoredUser(hostname, username) {
  try {
    if (username) localStorage.setItem(LS_PREFIX + hostname, username);
    else          localStorage.removeItem(LS_PREFIX + hostname);
  } catch {}
}

// ─── Username modal ───────────────────────────────────────────────────────────

/**
 * Guard against two concurrent promptUsername calls sharing the same modal DOM.
 * The second caller receives null immediately instead of corrupting shared
 * event listeners.
 */
let modalBusy = false;

/**
 * Show the styled username modal and return a Promise that resolves with the
 * entered username string, or null if the user cancelled.
 * @param {object} device  — the device object (for displayName + hostname key)
 */
function promptUsername(device) {
  // Race guard: reject concurrent calls immediately
  if (modalBusy) return Promise.resolve(null);
  modalBusy = true;

  return new Promise((resolve) => {
    const key = device.displayName || device.name;

    // Pre-fill with last-used value (or OS-appropriate default)
    const stored = getStoredUser(key);
    const defaultUser = stored || (device.os?.toLowerCase().includes("darwin") ? "" : "root");
    usernameInput.value = defaultUser;

    // Null-safe address display
    const addrs = device.addresses ?? [];
    const firstAddr = addrs[0] ?? device.name ?? key;
    usernameModalDesc.textContent = `Connecting to ${key} (${firstAddr})`;

    usernameModal.classList.remove("hidden");
    // Focus & select all so the user can immediately type a replacement
    usernameInput.focus();
    usernameInput.select();

    const cleanup = (result) => {
      modalBusy = false;
      usernameModal.classList.add("hidden");
      offCancel();
      offConnect();
      offKey();
      resolve(result);
    };

    const onConnect = () => {
      const val = usernameInput.value.trim();
      if (!val) { usernameInput.focus(); return; }
      cleanup(val);
    };
    const onCancel = () => cleanup(null);
    const onKey = (e) => {
      if (e.key === "Enter")  { e.preventDefault(); onConnect(); }
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };

    usernameConnectBtn.addEventListener("click", onConnect);
    usernameCancelBtn.addEventListener("click", onCancel);
    usernameInput.addEventListener("keydown", onKey);

    // Remove listeners exactly once via named refs
    const offConnect = () => usernameConnectBtn.removeEventListener("click", onConnect);
    const offCancel  = () => usernameCancelBtn.removeEventListener("click", onCancel);
    const offKey     = () => usernameInput.removeEventListener("keydown", onKey);
  });
}

// ─── Tab manager ─────────────────────────────────────────────────────────────

/**
 * Create a new tab with a picker pane and activate it.
 * @param {object} ipn  — the live Tailscale IPN instance
 * @returns the tab object
 */
function createTab(ipn) {
  const id = ++tabIdSeq;

  // ── tab button ──
  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.dataset.id = id;
  tabEl.draggable = true;

  const labelSpan = document.createElement("span");
  labelSpan.className = "tab-label";
  labelSpan.textContent = "New tab";

  const closeBtn = document.createElement("button");
  closeBtn.className = "tab-close";
  closeBtn.title = "Close tab";
  closeBtn.textContent = "✕";

  tabEl.appendChild(labelSpan);
  tabEl.appendChild(closeBtn);

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(id);
  });
  tabEl.addEventListener("click", () => activateTab(id));

  // ── drag-and-drop reorder ──
  tabEl.addEventListener("dragstart", onDragStart);
  tabEl.addEventListener("dragover",  onDragOver);
  tabEl.addEventListener("dragleave", onDragLeave);
  tabEl.addEventListener("drop",      onDrop);
  tabEl.addEventListener("dragend",   onDragEnd);

  tabList.appendChild(tabEl);

  // ── pane ──
  const paneEl = document.createElement("div");
  paneEl.className = "pane";
  paneEl.dataset.id = id;
  paneHost.appendChild(paneEl);

  const tab = { id, tabEl, paneEl, session: null, label: "New tab" };
  tabs.push(tab);

  activateTab(id);
  loadPicker(tab, ipn).catch(err => console.error("[loadPicker]", err));

  return tab;
}

function getTab(id) {
  return tabs.find(t => t.id === id) ?? null;
}

function activateTab(id) {
  activeTabId = id;
  for (const t of tabs) {
    t.tabEl.classList.toggle("active", t.id === id);
    t.paneEl.classList.toggle("active", t.id === id);
  }
  // scroll the active tab into view in the tab bar
  const tab = getTab(id);
  if (tab) tab.tabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function setTabLabel(id, label) {
  const tab = getTab(id);
  if (!tab) return;
  tab.label = label;
  const labelEl = tab.tabEl.querySelector(".tab-label");
  if (labelEl) labelEl.textContent = label;
}

function closeTab(id) {
  const tab = getTab(id);
  if (!tab) return;

  // Gracefully close SSH session if one is open
  if (tab.session) {
    try { tab.session.close(); } catch {}
    tab.session = null;
  }

  tab.tabEl.remove();
  tab.paneEl.remove();
  const idx = tabs.findIndex(t => t.id === id);
  tabs.splice(idx, 1);

  if (tabs.length === 0) {
    // Last tab closed — open a fresh one automatically so the UI is never blank
    if (globalIpn) createTab(globalIpn);
    return;
  }

  // Activate nearest tab
  if (activeTabId === id) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    activateTab(next.id);
  }
}

/**
 * Silently destroy every tab (closing live SSH sessions) without triggering
 * the auto-open-new-tab behaviour. Used when the IPN node logs out so stale
 * device lists are not shown to the user.
 */
function clearAllTabs() {
  for (const tab of [...tabs]) {
    if (tab.session) {
      try { tab.session.close(); } catch {}
      tab.session = null;
    }
    tab.tabEl.remove();
    tab.paneEl.remove();
  }
  tabs.length = 0;
  activeTabId = null;
}

// ─── Drag-and-drop reorder ───────────────────────────────────────────────────

let dragSrcId = null;

function onDragStart(e) {
  dragSrcId = Number(e.currentTarget.dataset.id);
  e.dataTransfer.effectAllowed = "move";
  // Use a tiny delay so the drag image renders before we style the element
  requestAnimationFrame(() => e.currentTarget.style.opacity = "0.4");
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  e.currentTarget.classList.add("drag-over");
}

function onDragLeave(e) {
  e.currentTarget.classList.remove("drag-over");
}

function onDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove("drag-over");
  const targetId = Number(e.currentTarget.dataset.id);
  if (dragSrcId === null || dragSrcId === targetId) return;

  const srcIdx = tabs.findIndex(t => t.id === dragSrcId);
  const dstIdx = tabs.findIndex(t => t.id === targetId);
  if (srcIdx === -1 || dstIdx === -1) return;

  // Capture the destination tab's DOM element BEFORE mutating the array.
  // After splice the indices shift, so reading tabs[dstIdx] afterwards gives
  // the wrong element for left-to-right drags (off-by-one bug).
  const dstTabEl = tabs[dstIdx].tabEl;

  // Reorder in the array
  const [srcTab] = tabs.splice(srcIdx, 1);
  tabs.splice(dstIdx, 0, srcTab);

  // Reorder in the DOM — insert srcTab before the original destination element
  tabList.insertBefore(srcTab.tabEl, dstTabEl);
}

function onDragEnd(e) {
  e.currentTarget.style.opacity = "";
  dragSrcId = null;
  document.querySelectorAll(".tab.drag-over").forEach(el => el.classList.remove("drag-over"));
}

// ─── Picker ──────────────────────────────────────────────────────────────────

async function loadPicker(tab, ipn) {
  setTabLabel(tab.id, "New tab");

  const pane = tab.paneEl;

  // Build picker DOM imperatively to avoid any innerHTML injection risk
  const picker = document.createElement("div");
  picker.className = "picker";

  const pickerHeader = document.createElement("div");
  pickerHeader.className = "picker-header";
  const h1 = document.createElement("h1");
  h1.textContent = "Choose a machine";
  const subtitle = document.createElement("p");
  subtitle.className = "picker-subtitle";
  subtitle.textContent = "Select a machine from your tailnet to open an SSH session.";
  pickerHeader.appendChild(h1);
  pickerHeader.appendChild(subtitle);

  const searchWrap = document.createElement("div");
  searchWrap.className = "picker-search-wrap";
  const searchIcon = document.createElement("span");
  searchIcon.className = "picker-search-icon";
  searchIcon.textContent = "⌕";
  const searchInput = document.createElement("input");
  searchInput.className = "picker-search";
  searchInput.type = "search";
  searchInput.placeholder = "Filter by name, OS, or IP…";
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchWrap.appendChild(searchIcon);
  searchWrap.appendChild(searchInput);

  const grid = document.createElement("div");
  grid.className = "device-grid";
  const loadingMsg = document.createElement("p");
  loadingMsg.style.cssText = "color:var(--muted);font-size:13px";
  loadingMsg.textContent = "Loading devices…";
  grid.appendChild(loadingMsg);

  const errorEl = document.createElement("div");
  errorEl.className = "picker-error";

  picker.appendChild(pickerHeader);
  picker.appendChild(searchWrap);
  picker.appendChild(grid);
  picker.appendChild(errorEl);

  pane.innerHTML = "";
  pane.appendChild(picker);

  let devices;
  try {
    const resp = await fetch("/api/devices");
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    devices = await resp.json();
  } catch (err) {
    grid.innerHTML = "";
    errorEl.textContent = `Could not load devices: ${err.message}`;
    errorEl.classList.add("visible");
    return;
  }

  if (!devices.length) {
    grid.innerHTML = "";
    const msg = document.createElement("p");
    msg.style.cssText = "color:var(--muted);font-size:13px";
    msg.textContent = "No devices found in your tailnet.";
    grid.appendChild(msg);
    return;
  }

  // Sort: SSH-enabled first, then online, then alphabetically
  devices.sort((a, b) => {
    if (a.sshEnabled !== b.sshEnabled) return a.sshEnabled ? -1 : 1;
    if (a.online     !== b.online)     return a.online     ? -1 : 1;
    return (a.displayName || a.name || "").localeCompare(b.displayName || b.name || "");
  });

  // Build all cards once; show/hide based on search query
  const cards = devices.map(d => ({ device: d, el: buildCard(d, tab, ipn) }));

  const renderCards = (query) => {
    const q = query.trim().toLowerCase();
    grid.innerHTML = "";
    let shown = 0;
    for (const { device: d, el } of cards) {
      const haystack = [
        d.displayName, d.hostname, d.os, ...(d.addresses ?? [])
      ].join(" ").toLowerCase();
      if (!q || haystack.includes(q)) {
        grid.appendChild(el);
        shown++;
      }
    }
    if (shown === 0) {
      const msg = document.createElement("p");
      msg.className = "picker-no-results";
      msg.textContent = `No devices match "${query}".`;
      grid.appendChild(msg);
    }
  };

  renderCards("");
  searchInput.addEventListener("input", () => renderCards(searchInput.value));
  // Auto-focus the search bar (convenience for power users)
  searchInput.focus();
}

/**
 * Build a device card DOM node without using innerHTML for dynamic content,
 * eliminating XSS risk from device names/OS/IP fields.
 */
function buildCard(device, tab, ipn) {
  const addrs      = device.addresses ?? [];
  const ipv4       = addrs.find(a => !a.includes(":")) ?? device.name ?? "";
  const ipv6       = addrs.find(a =>  a.includes(":")) ?? null;
  const addr       = ipv4;  // connect over IPv4
  const displayName = device.displayName || (device.name ? device.name.split(".")[0] : "unknown");
  const canConnect  = device.online && device.sshEnabled;
  const disabledReason = !device.online
    ? "Device is offline"
    : !device.sshEnabled
    ? "Tailscale SSH not enabled on this device"
    : null;

  const card = document.createElement("div");
  card.className = "device-card";

  // ── header ──
  const cardHeader = document.createElement("div");
  cardHeader.className = "device-card-header";

  const iconEl = document.createElement("div");
  iconEl.className = "device-icon";
  iconEl.textContent = osIcon(device.os);

  const infoEl = document.createElement("div");
  const nameEl = document.createElement("div");
  nameEl.className = "device-name";
  nameEl.textContent = displayName;
  const osEl = document.createElement("div");
  osEl.className = "device-os";
  osEl.textContent = device.os || "unknown";
  infoEl.appendChild(nameEl);
  infoEl.appendChild(osEl);

  cardHeader.appendChild(iconEl);
  cardHeader.appendChild(infoEl);

  // ── meta ──
  const metaEl = document.createElement("div");
  metaEl.className = "device-meta";

  const ipv4El = document.createElement("span");
  ipv4El.className = "device-addr";
  ipv4El.textContent = ipv4;
  metaEl.appendChild(ipv4El);

  if (ipv6) {
    const ipv6El = document.createElement("span");
    ipv6El.className = "device-addr device-addr-v6";
    ipv6El.textContent = ipv6;
    metaEl.appendChild(ipv6El);
  }

  const lastSeenEl = document.createElement("span");
  lastSeenEl.className = "device-lastseen";
  lastSeenEl.textContent = `Last seen: ${relativeTime(device.lastSeen)}`;
  metaEl.appendChild(lastSeenEl);

  // ── footer ──
  const footerEl = document.createElement("div");
  footerEl.className = "device-card-footer";

  const badgeEl = document.createElement("span");
  badgeEl.className = `online-badge ${device.online ? "online" : "offline"}`;
  badgeEl.textContent = device.online ? "Online" : "Offline";

  const connectBtn = document.createElement("button");
  connectBtn.className = "connect-btn";
  connectBtn.textContent = device.sshEnabled ? "Connect" : "SSH disabled";
  if (!canConnect) {
    connectBtn.disabled = true;
    if (disabledReason) connectBtn.title = disabledReason;
  }

  footerEl.appendChild(badgeEl);
  footerEl.appendChild(connectBtn);

  card.appendChild(cardHeader);
  card.appendChild(metaEl);
  card.appendChild(footerEl);

  if (canConnect) {
    connectBtn.addEventListener("click", () =>
      openSession(tab, device, addr, displayName, ipn).catch(err =>
        console.error("[openSession]", err)
      )
    );
  }
  return card;
}

// ─── SSH session ──────────────────────────────────────────────────────────────

async function openSession(tab, device, addr, displayName, ipn) {
  // Guard: if a session is already active on this tab, do nothing
  if (tab.session) return;

  const user = await promptUsername(device);
  if (!user) return;  // cancelled

  // Guard again after async promptUsername (another click could have snuck in)
  if (tab.session) return;

  // Persist username for next time (pre-fills the modal on subsequent opens)
  setStoredUser(device.displayName || device.name, user);

  const label = `${user}@${displayName}`;
  setTabLabel(tab.id, label);

  // Replace pane content with a terminal wrapper
  tab.paneEl.innerHTML = "";
  const termEl = document.createElement("div");
  termEl.className = "terminal-wrap";
  tab.paneEl.appendChild(termEl);

  let closed = false;

  const session = runSSHSession(
    termEl,
    { hostname: addr, username: user, timeoutSeconds: 30 },
    ipn,
    {
      onConnectionProgress(msg) { console.log(`[ssh:${label}] progress:`, msg); },
      onConnected()             { console.log(`[ssh:${label}] connected`); },
      onError(err) {
        console.error(`[ssh:${label}] error:`, err);
        if (!closed) onSessionEnd(tab, ipn);
      },
      onDone() {
        console.log(`[ssh:${label}] done`);
        if (!closed) onSessionEnd(tab, ipn);
      },
    },
    xtermOptions()
  );

  tab.session = {
    close() {
      closed = true;
      try { session?.close?.(); } catch {}
    },
  };
}

function onSessionEnd(tab, ipn) {
  tab.session = null;
  tab.paneEl.innerHTML = "";
  loadPicker(tab, ipn).catch(err => console.error("[onSessionEnd→loadPicker]", err));
}

function xtermOptions() {
  return {
    fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", monospace',
    fontSize: 14,
    lineHeight: 1.2,
    theme: {
      background:          "#1c1c1e",
      foreground:          "#f2f2f7",
      cursor:              "#f2f2f7",
      cursorAccent:        "#1c1c1e",
      selectionBackground: "rgba(10,132,255,0.25)",
      black:               "#48484a",
      red:                 "#ff453a",
      green:               "#30d158",
      yellow:              "#ffd60a",
      blue:                "#0a84ff",
      magenta:             "#bf5af2",
      cyan:                "#5ac8fa",
      white:               "#aeaeb2",
      brightBlack:         "#636366",
      brightRed:           "#ff6961",
      brightGreen:         "#34c759",
      brightYellow:        "#ffd426",
      brightBlue:          "#409cff",
      brightMagenta:       "#da8fff",
      brightCyan:          "#70d7ff",
      brightWhite:         "#f2f2f7",
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Boot Tailscale WASM ──────────────────────────────────────────────
  showLoading("Loading Tailscale WASM…");
  let ipn;
  try {
    ipn = await createIPN({
      stateStorage: {
        setState(id, value) { try { sessionStorage.setItem(`ts:${id}`, value); } catch {} },
        getState(id)        { try { return sessionStorage.getItem(`ts:${id}`) ?? ""; } catch { return ""; } },
      },
      panicHandler(err) {
        console.error("[tailscale] panic:", err);
        // panicHandler is synchronous; show the error directly
        showLoading(`Tailscale crashed: ${err}`);
        clearAllTabs();
      },
    });
  } catch (err) {
    showLoading(`Failed to load Tailscale: ${err.message}`);
    console.error(err);
    return;
  }

  // ── Start IPN state machine ──────────────────────────────────────────
  let loginTimer = null;
  let buttonsWired = false;

  const scheduleLogin = () => {
    if (loginTimer !== null) clearTimeout(loginTimer);
    loginTimer = setTimeout(() => {
      loginTimer = null;
      console.log("[tailscale] calling ipn.login() (deferred)");
      ipn.login();
    }, 0);
  };

  // Track whether the IPN has ever reached Running so we can detect
  // post-Running Stopped/panic transitions that would otherwise be swallowed
  // by the already-settled ipnRunning Promise.
  let ipnEverRan = false;

  ipn.run({
    notifyState(state) {
      console.log("[tailscale] state →", state);
      setStatus(state);
      switch (state) {
        case "Running":
          if (loginTimer !== null) { clearTimeout(loginTimer); loginTimer = null; }
          hideAuthOverlay();
          hideLoading();
          ipnEverRan = true;
          // Wire buttons and open first tab only once
          if (!buttonsWired) {
            buttonsWired = true;
            globalIpn = ipn;
            newTabBtn.addEventListener("click", () => createTab(ipn));
            logoutBtn.addEventListener("click", () => {
              logoutBtn.disabled = true;
              logoutBtn.textContent = "Logging out…";
              ipn.logout();
            });
          }
          // Open a fresh tab every time we reach Running (including after re-login)
          if (tabs.length === 0) createTab(ipn);
          break;
        case "NeedsLogin":
        case "NeedsMachineAuth":
          clearAllTabs();
          showLoading("Waiting for Tailscale authentication…");
          scheduleLogin();
          break;
        case "Stopped":
          clearAllTabs();
          if (ipnEverRan) {
            // Post-Running stop: surface the error directly rather than relying
            // on a rejected Promise that is already settled.
            showLoading("Tailscale node stopped unexpectedly.");
          }
          break;
      }
    },
    notifyBrowseToURL(url) {
      console.log("[tailscale] login URL:", url);
      hideLoading();
      showAuthOverlay(url);
      window.open(url, "_blank", "noopener,noreferrer");
    },
    notifyNetMap(netMapJSON) {
      try {
        const nm = JSON.parse(netMapJSON);
        console.log("[tailscale] netmap — self:", nm.self?.name,
          "peers:", nm.peers?.length ?? 0);
      } catch {
        console.debug("[tailscale] netmap (raw):", netMapJSON);
      }
    },
    notifyPanicRecover(err) {
      console.error("[tailscale] panic:", err);
      clearAllTabs();
      // Surface post-Running panics directly; the Promise machinery won't help.
      showLoading(`Tailscale panic: ${err}`);
    },
  });
}

authOpenBtn.addEventListener("click", () => {
  if (pendingLoginURL) window.open(pendingLoginURL, "_blank", "noopener,noreferrer");
});

main().catch((err) => {
  console.error("[TailSSH] Fatal error:", err);
  showLoading(`Fatal error: ${err.message}`);
});
