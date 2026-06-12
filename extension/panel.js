// netbridge DevTools panel: discovers a running collector on localhost and
// embeds its UI. Re-scans while disconnected; reconnects after restarts.

const DEFAULT_PORTS = Array.from({ length: 12 }, (_, i) => 4499 + i);
const STORAGE_KEY = 'netbridge-panel-port';

const $connect = document.getElementById('connect');
const $status = document.getElementById('status');
const $port = document.getElementById('port');
const $retry = document.getElementById('retry');
const $ui = document.getElementById('ui');

let connectedPort = null;
let scanning = false;

async function probe(port) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 400);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    const data = await res.json();
    return data && data.app === 'netbridge' ? port : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function scan() {
  if (scanning) return;
  scanning = true;
  $status.textContent = 'looking for a running collector…';

  const manual = Number($port.value || localStorage.getItem(STORAGE_KEY) || 0);
  const candidates = manual ? [manual, ...DEFAULT_PORTS] : DEFAULT_PORTS;
  const results = await Promise.all(candidates.map(probe));
  const found = results.find((p) => p !== null);

  if (found) {
    connect(found);
  } else {
    $status.textContent = 'no collector found on localhost';
  }
  scanning = false;
}

function connect(port) {
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
setInterval(async () => {
  if (connectedPort !== null) {
    const ok = await probe(connectedPort);
    if (ok === null) disconnect();
  } else {
    scan();
  }
}, 3000);

$retry.addEventListener('click', scan);
$port.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') scan();
});

scan();
