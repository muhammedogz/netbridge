// netbridge DevTools panel: discovers a running collector on localhost and
// embeds its UI. Re-scans while disconnected; reconnects after restarts.
// With several collectors running (one per app), it picks the one whose app
// serves the inspected page: collectors report the ports their app listens
// on in /api/health.

const DEFAULT_PORTS = Array.from({ length: 12 }, (_, i) => 4499 + i);
const STORAGE_KEY = 'netbridge-panel-port';

const $connect = document.getElementById('connect');
const $status = document.getElementById('status');
const $port = document.getElementById('port');
const $retry = document.getElementById('retry');
const $ui = document.getElementById('ui');

let connectedPort = null;
let scanning = false;

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(t);
  }
}

/** { port, appPorts } for a collector on `port`, or null. */
async function probe(port) {
  // netbridge >= 0.1.2 identifies itself explicitly.
  const health = await fetchJson(`http://127.0.0.1:${port}/api/health`, 400);
  if (health && health.app === 'netbridge') {
    return { port, appPorts: Array.isArray(health.ports) ? health.ports : [] };
  }
  if (health !== undefined) return null; // some other app answered — not ours

  // Fallback for older collectors (0.1.0/0.1.1) without /api/health:
  // they expose /api/requests returning a JSON array.
  const requests = await fetchJson(`http://127.0.0.1:${port}/api/requests`, 400);
  return Array.isArray(requests) ? { port, appPorts: [] } : null;
}

/** Port of the page being inspected, or null (not an http page). */
function inspectedPort() {
  return new Promise((resolve) => {
    try {
      chrome.devtools.inspectedWindow.eval(
        "location.protocol.startsWith('http') ? (location.port || (location.protocol === 'https:' ? '443' : '80')) : ''",
        (result, error) => resolve(error || !result ? null : Number(result))
      );
    } catch {
      resolve(null);
    }
  });
}

/** The collector for the inspected page, else the first one found. */
async function findCollector() {
  const manual = Number($port.value || localStorage.getItem(STORAGE_KEY) || 0);
  const candidates = manual ? [manual, ...DEFAULT_PORTS.filter((p) => p !== manual)] : DEFAULT_PORTS;
  const [results, pagePort] = await Promise.all([Promise.all(candidates.map(probe)), inspectedPort()]);
  const found = results.filter((r) => r !== null);
  const match = found.find((r) => r.appPorts.includes(pagePort));
  return { best: match ?? found[0] ?? null, matched: Boolean(match) };
}

async function scan() {
  if (scanning) return;
  scanning = true;
  $status.textContent = 'looking for a running collector…';
  const { best } = await findCollector();
  if (best) {
    connect(best.port);
  } else {
    $status.textContent = 'no collector found on localhost';
  }
  scanning = false;
}

// After a navigation (or when another app starts), switch to the collector
// whose app serves the page, if that isn't the one shown.
async function recheck() {
  if (scanning || connectedPort === null) return;
  scanning = true;
  try {
    const { best, matched } = await findCollector();
    if (matched && best.port !== connectedPort) connect(best.port);
  } finally {
    scanning = false;
  }
}

function connect(port) {
  if (connectedPort === port && !$ui.hidden) return;
  connectedPort = port;
  try {
    localStorage.setItem(STORAGE_KEY, String(port));
  } catch {
    /* ignore */
  }
  $ui.src = `http://127.0.0.1:${port}/`;
  $ui.hidden = false;
  $connect.hidden = true;
}

function disconnect() {
  connectedPort = null;
  $ui.hidden = true;
  $ui.src = 'about:blank';
  $connect.hidden = false;
}

// Watchdog: if the collector goes away (app stopped), fall back to the
// connect screen and keep scanning so a restart reattaches automatically.
let ticks = 0;
setInterval(async () => {
  if (connectedPort !== null) {
    const ok = await probe(connectedPort);
    if (ok === null) disconnect();
    // Every few ticks: a collector for the inspected page may have started.
    else if (++ticks % 3 === 0) recheck();
  } else {
    scan();
  }
}, 3000);

try {
  chrome.devtools.network.onNavigated.addListener(() => recheck());
} catch {
  /* outside DevTools (opened as a plain page) */
}

$retry.addEventListener('click', scan);
$port.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') scan();
});

scan();
