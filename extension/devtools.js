// Registers the netbridge panel in DevTools. The panel itself (panel.html)
// discovers and embeds the locally running netbridge collector UI.
chrome.devtools.panels.create('netbridge', '', 'panel.html', () => {});
