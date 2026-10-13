// netbridge --overlay: added to the app's HTML pages. Draws the bubble as an
// iframe from the collector, so captured traffic never enters the page; this
// script only places and sizes that iframe.
(() => {
  const script = document.currentScript;
  if (!script || window.__netbridgeOverlay) return;
  window.__netbridgeOverlay = true;
  const origin = new URL(script.src).origin;
  const trace = script.dataset.trace || '';
  // Out of the way of frameworks that hydrate <body>.
  script.remove();

  const mount = () => {
    const host = document.createElement('netbridge-overlay');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:block;';
    const root = host.attachShadow({ mode: 'closed' });
    const frame = document.createElement('iframe');
    frame.src = `${origin}/overlay.html?trace=${encodeURIComponent(trace)}`;
    frame.title = 'netbridge';
    frame.style.cssText =
      'display:block;border:0;width:0;height:0;border-radius:16px;color-scheme:normal;box-shadow:0 4px 16px rgba(0,0,0,.35);';
    root.appendChild(frame);
    window.addEventListener('message', (e) => {
      if (e.origin !== origin || e.source !== frame.contentWindow) return;
      const d = e.data;
      if (!d || d.netbridge !== 'size') return;
      frame.style.width = `${d.width}px`;
      frame.style.height = `${d.height}px`;
      frame.style.borderRadius = `${d.radius}px`;
    });
    document.documentElement.appendChild(host);
  };
  // After load, when hydration of the page has had its turn.
  if (document.readyState === 'complete') setTimeout(mount, 0);
  else window.addEventListener('load', () => setTimeout(mount, 0), { once: true });
})();
