// Edge cases for the capture wrappers. Uses the test origin (TARGET_ORIGIN)
// plus servers of its own on ::1 and on a unix socket. Tags each call with
// ?case=<name>.
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const origin = process.env.TARGET_ORIGIN;
const u = (route, name) => `${origin}${route}${route.includes('?') ? '&' : '?'}case=${name}`;
const get = (opts) =>
  new Promise((resolve, reject) => {
    http.get(opts, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });

// Same slow endpoint through both stacks: durations must agree.
await (await fetch(u('/slow', 'slow-fetch'))).text();
await get(u('/slow', 'slow-http'));

// A Request object carrying a body larger than the capture limit, as a
// string and as a stream: the capture must stay bounded and the origin must
// still receive every byte.
const BIG = 'z'.repeat(3 * 1024 * 1024);
const r1 = await fetch(new Request(u('/echo', 'request-string'), { method: 'POST', body: BIG }));
console.log(`[edge] request-string echoed ${JSON.parse(await r1.text()).echoed.length}`);
const stream = new ReadableStream({
  start(controller) {
    for (let i = 0; i < 48; i++) controller.enqueue(new TextEncoder().encode('s'.repeat(64 * 1024)));
    controller.close();
  },
});
const r2 = await fetch(new Request(u('/echo', 'request-stream'), { method: 'POST', body: stream, duplex: 'half' }));
console.log(`[edge] request-stream echoed ${JSON.parse(await r2.text()).echoed.length}`);

// IPv6 literal host: the url needs brackets.
const v6 = http.createServer((_req, res) => res.end('v6'));
try {
  await new Promise((resolve, reject) => v6.once('error', reject).listen(0, '::1', resolve));
  await get({ host: '::1', port: v6.address().port, path: '/v6?case=ipv6' });
} catch {
  console.log('[edge] no ipv6 loopback, skipped');
}
v6.close();

// Unix socket (Docker API style): no host at all.
if (process.platform !== 'win32') {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-sock-')), 's.sock');
  const unix = http.createServer((_req, res) => res.end('unix'));
  await new Promise((resolve) => unix.listen(sock, resolve));
  await get({ socketPath: sock, path: '/containers/json?case=unix' });
  unix.close();
}

console.log('[edge] all requests done');
// Bounded, in case the test's stop never reaches this process (Windows).
setTimeout(() => process.exit(0), 60_000);
