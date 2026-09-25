// Exercises both HTTP stacks against the test origin (TARGET_ORIGIN), then
// stays alive until the test stops netbridge.
import http from 'http';

const origin = process.env.TARGET_ORIGIN;

// 1) native fetch GET with a secret and a plain header
const r1 = await fetch(`${origin}/json`, {
  headers: { authorization: 'Bearer super-secret', 'x-test': 'fetch-get' },
});
await r1.json();

// 2) native fetch POST with JSON body
const r2 = await fetch(`${origin}/echo`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ hello: 'from-fetch', n: 42 }),
});
await r2.json();

// 3) classic http.get against a gzip response. Simulate axios: consumers
// delete content-encoding from res.headers when they decompress themselves.
await new Promise((resolve, reject) => {
  http.get(`${origin}/gzip`, (res) => {
    delete res.headers['content-encoding'];
    res.on('data', () => {});
    res.on('end', resolve);
    res.on('error', reject);
  });
});

// 4) classic http.request POST with a body
await new Promise((resolve, reject) => {
  const { hostname, port } = new URL(origin);
  const req = http.request(
    { host: hostname, port, path: '/echo', method: 'POST', headers: { 'content-type': 'application/json' } },
    (res) => {
      res.resume();
      res.on('end', resolve);
    }
  );
  req.on('error', reject);
  req.end(JSON.stringify({ hello: 'from-http', n: 7 }));
});

// 5) fetch whose connection the origin drops: must settle as state=error
try {
  await fetch(`${origin}/boom`);
} catch {
  /* expected */
}

console.log('[target] all requests done');
// Bounded, in case the test's stop never reaches this process (Windows).
setTimeout(() => process.exit(0), 60_000);
