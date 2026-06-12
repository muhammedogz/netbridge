/**
 * netbridge preload — injected via NODE_OPTIONS="--require .../preload.js".
 *
 * Runs before the host app (and before frameworks patch fetch), wraps both of
 * Node's HTTP stacks, and streams captured events to the netbridge collector.
 *
 * Hard rules:
 * - never crash the host app (everything is try/catch'd)
 * - no-op entirely unless NETBRIDGE_PORT is set (i.e. launched via the CLI)
 * - never keep the host process alive (timers are unref'd)
 */
try {
  if (process.env.NETBRIDGE_PORT) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { patchFetch } = require('./capture/fetch');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { patchHttp } = require('./capture/http');
    patchHttp();
    patchFetch();
    if (process.env.NETBRIDGE_QUIET !== '1') {
      // eslint-disable-next-line no-console
      console.log(
        `[netbridge] capturing server-side HTTP in pid ${process.pid} → http://localhost:${process.env.NETBRIDGE_PORT}`
      );
    }
  }
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn('[netbridge] failed to initialize capture:', (err as Error).message);
}
