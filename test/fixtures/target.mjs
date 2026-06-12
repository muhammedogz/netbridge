// Smoke-test target: exercises both HTTP stacks against the local origin.
// Origin port arrives via TARGET_ORIGIN_PORT.
import http from 'http';

const origin = `http://127.0.0.1:${process.env.TARGET_ORIGIN_PORT}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) native fetch GET (gzip handled transparently by undici)
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

// 3) classic http.get — origin responds gzip; capture layer must decompress.
// Simulate axios: consumers delete content-encoding from res.headers when
// they handle decompression themselves — capture must survive that.
await new Promise((resolve, reject) => {
  http.get(`${origin}/gzip`, (res) => {
    delete res.headers['content-encoding'];
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', resolve);
    res.on('error', reject);
  });
});

// 4) classic http.request POST with a body
await new Promise((resolve, reject) => {
  const req = http.request(
    { host: '127.0.0.1', port: process.env.TARGET_ORIGIN_PORT, path: '/echo', method: 'POST', headers: { 'content-type': 'application/json' } },
    (res) => {
      res.resume();
      res.on('end', resolve);
    }
  );
  req.on('error', reject);
  req.end(JSON.stringify({ hello: 'from-http', n: 7 }));
});

console.log('[target] all requests done');
// Give the collector time to be queried by the test before this process exits.
await delay(2500);
