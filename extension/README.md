# netbridge DevTools extension

Adds a **netbridge** tab to Chrome DevTools (like React DevTools does) showing
your server-side network traffic right next to the browser's own Network tab —
client and server requests in one window.

It contains no capture logic: the panel auto-discovers a running netbridge
collector on localhost (ports 4499–4510, or a manual port) and embeds its UI.
Stop/restart your dev process freely — the panel reconnects automatically.

## Install (unpacked, while not on the Web Store)

1. `chrome://extensions` → enable **Developer mode** (top right)
2. **Load unpacked** → select this `extension/` folder
3. Open DevTools on any page → **netbridge** tab
4. Start your app: `npx netbridge -- next dev` — the panel connects by itself

Works in Chrome, Edge, Brave, and other Chromium browsers.

## Notes

- The panel needs `host_permissions` for `localhost` only — it never touches
  any other origin.
- Web Store publishing checklist: icons (16/48/128 PNG), screenshots,
  $5 developer registration, privacy disclosure ("no data collected" — all
  traffic stays on localhost).
