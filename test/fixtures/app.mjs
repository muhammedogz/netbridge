// An app server for the correlation, mock and overlay tests: each route makes
// outbound calls to TARGET_ORIGIN while handling the request.
import http from 'http';
import { createRequire } from 'module';

const target = process.env.TARGET_ORIGIN;
const require = createRequire(import.meta.url);

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

async function fetchText(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

const routes = {
  // Two identical calls in sequence, then one over http: a duplicate and
  // two sequential steps.
  async '/page'() {
    await fetchText(`${target}/json`);
    await fetchText(`${target}/json`);
    await httpGet(`${target}/json?via=http`);
    return 'page done';
  },
  async '/mocked'() {
    const viaFetch = await fetchText(`${target}/mock-me`);
    const viaHttp = await httpGet(`${target}/mock-me`);
    return JSON.stringify({ fetch: viaFetch, http: viaHttp });
  },
  async '/fail'() {
    try {
      await fetch(`${target}/json?fail`);
      return 'no error';
    } catch (err) {
      return `failed: ${err.cause?.message ?? err.message}`;
    }
  },
  async '/undici'() {
    const undici = require('undici');
    const res = await undici.request(`${target}/json?via=undici`);
    return await res.body.text();
  },
};

const server = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/html') {
    await fetchText(`${target}/json?for=html`);
    const html = '<!doctype html><html><body><h1>app</h1></body></html>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
    res.end(html);
    return;
  }
  if (path === '/later') {
    // Work after the response: a call right away still belongs to the
    // request; one from a timer long after it (a telemetry flush) does not.
    res.end('sent');
    fetchText(`${target}/json?soon`).catch(() => {});
    setTimeout(() => fetchText(`${target}/json?late`).catch(() => {}), 3500);
    return;
  }
  if (path === '/html-twice') {
    // A defensive second end(): a no-op in Node, so it must stay one.
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>twice</body></html>');
    res.end();
    return;
  }
  if (path === '/html-404') {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html><body>missing</body></html>');
    return;
  }
  if (path === '/origin-post') {
    // A mocked POST that forwards the browser's Origin header.
    const body = await new Promise((resolve, reject) => {
      const req = http.request(`${target}/mock-me`, { method: 'POST', headers: { origin: 'http://localhost:3000' } }, (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => resolve(`${r.statusCode} ${b}`));
      });
      req.on('error', reject);
      req.end('{}');
    });
    res.end(body);
    return;
  }
  if (path === '/http-post') {
    const body = await new Promise((resolve) => {
      const req = http.request(`${target}/echo`, { method: 'POST' }, (r) => {
        r.resume();
        r.on('end', () => resolve(`status ${r.statusCode}`));
      });
      req.on('error', (err) => resolve(`error ${err.message}`));
      req.end('side effect');
    });
    res.end(body);
    return;
  }
  const route = routes[path];
  if (!route) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await route();
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
});
server.listen(0, '127.0.0.1');
