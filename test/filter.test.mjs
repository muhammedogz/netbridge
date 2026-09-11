/**
 * netbridge filter test: the UI's filter language (ui-src/src/filter.ts).
 *
 * filter.ts has no runtime imports, so it is transpiled with the TypeScript
 * compiler and imported from memory. No build step, no browser.
 *
 * Covers: parsing, free-text include/exclude, keyed terms and aliases,
 * combinations, empty/incomplete/odd input, case handling, chips, and
 * seeding the filter from --exclude.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(__dirname, '..', 'ui-src', 'src', 'filter.ts');

const { outputText } = ts.transpileModule(fs.readFileSync(SOURCE, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { parseFilter, matchesFilter, matchesStructured, exclusionTerm, withExclusions } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, a === e ? label : `${label}\n      expected ${e}\n      got      ${a}`);
}

// --- fixture rows -----------------------------------------------------------
let seq = 0;
const row = (name, fields) => ({
  name,
  id: String(++seq),
  seq,
  ts: 0,
  source: 'fetch',
  method: 'GET',
  state: 'done',
  status: 200,
  ...fields,
});

const ROWS = [
  // OpenTelemetry exports to a local collector: the noise to hide
  row('traces', {
    method: 'POST',
    url: 'http://localhost:4318/v1/traces',
    source: 'http',
    reqBody: 'CgQKAgoA',
    reqBodyEncoding: 'base64',
  }),
  row('metrics', { method: 'POST', url: 'http://localhost:4318/v1/metrics', source: 'http' }),
  // mentions the collector only in its response body
  row('config', {
    url: 'http://config.internal/otel',
    resBody: '{"endpoint":"http://localhost:4318"}',
    resBodyEncoding: 'utf8',
  }),
  row('users', {
    url: 'https://api.example.com/users?page=2',
    resHeaders: { 'content-type': 'application/json' },
    resBody: '{"Order_ID": 42}',
    resBodyEncoding: 'utf8',
  }),
  row('created', {
    method: 'POST',
    url: 'https://api.example.com/orders',
    status: 201,
    reqBody: '{"sku":"A-1"}',
    reqBodyEncoding: 'utf8',
  }),
  row('deleted', { method: 'DELETE', url: 'https://api.example.com/orders/9', status: 404 }),
  row('upstream', { url: 'https://pay.example.com/charge', status: 502 }),
  row('slow', { url: 'https://slow.example.com/', state: 'pending', status: undefined }),
  row('refused', { url: 'http://localhost:9/', state: 'error', status: undefined, error: 'ECONNREFUSED' }),
  // base64 body whose raw text contains "b3JkZXJfaWQ" (base64 of "order_id")
  row('logo', { url: 'https://cdn.example.com/logo.png', resBody: 'b3JkZXJfaWQ=', resBodyEncoding: 'base64' }),
];
const ALL = ROWS.map((r) => r.name);
const visible = (query) => {
  const terms = parseFilter(query);
  return ROWS.filter((r) => matchesFilter(r, terms)).map((r) => r.name);
};
const allBut = (...names) => ALL.filter((n) => !names.includes(n));

// --- parsing ----------------------------------------------------------------
console.log('parsing');
const term = (key, value, negate = false) => ({ key, value, negate });
const keys = (query) => parseFilter(query).map((t) => t.key);
eq(parseFilter(''), [], 'empty query has no terms');
eq(parseFilter('  \t\n '), [], 'whitespace-only query has no terms');
eq(parseFilter('Order_ID'), [term(null, 'order_id')], 'plain term, lower-cased');
eq(parseFilter('-LocalHost:4318'), [term(null, 'localhost:4318', true)], 'unknown key is plain text; "-" negates');
eq(parseFilter('HOST:API.Example.com'), [term('host', 'api.example.com')], 'keyed term, lower-cased');
eq(keys('domain:a status-code:404'), ['host', 'status'], 'Chrome DevTools aliases domain: and status-code:');
eq(parseFilter('url:http://a:1/b'), [term('url', 'http://a:1/b')], 'value keeps the colons after the key');
eq(parseFilter('- host: -status: url:'), [], 'incomplete terms are ignored');
eq(parseFilter('--x'), [term(null, '-x', true)], 'only the first "-" negates');
eq(parseFilter(':x'), [term(null, ':x')], 'a leading colon is plain text');
eq(keys('constructor:x __proto__:y'), [null, null], 'Object.prototype names are not keys');
eq(keys('body method:get -host:x'), ['method', 'host', null], 'keyed terms sort before free text');

// --- free text --------------------------------------------------------------
console.log('free text');
eq(visible(''), ALL, 'empty filter keeps every row');
eq(visible('   '), ALL, 'blank filter keeps every row');
eq(visible('-'), ALL, 'a lone "-" keeps every row');
eq(visible('order_id'), ['users'], 'matches a utf8 body');
eq(visible('ORDER_id'), ['users'], 'case-insensitive');
eq(visible('application/json'), ['users'], 'matches header values');
eq(visible('example.com orders'), ['created', 'deleted'], 'terms AND together');
eq(visible('b3JkZXJfaWQ'), [], 'base64 bodies are not searched');
eq(visible('-localhost:4318'), allBut('traces', 'metrics', 'config'), '-term hides matches in bodies too');
for (const q of ['order_id', 'localhost', 'post', 'example.com']) {
  const shown = visible(q);
  const hidden = visible(`-${q}`);
  const partitions = shown.length + hidden.length === ALL.length && shown.every((n) => !hidden.includes(n));
  assert(partitions, `"${q}" and "-${q}" split the rows between them`);
}

// --- keyed terms ------------------------------------------------------------
console.log('keyed terms');
eq(visible('-host:localhost:4318'), allBut('traces', 'metrics'), '-host: hides only requests to that host');
eq(visible('-HOST:LocalHost:4318'), allBut('traces', 'metrics'), 'keyed terms are case-insensitive');
eq(visible('domain:localhost:4318'), ['traces', 'metrics'], 'domain: is host:');
eq(visible('host:4318'), ['traces', 'metrics'], 'host: includes the port');
eq(visible('host:/v1'), [], 'host: does not look at the path');
eq(visible('path:/v1/'), ['traces', 'metrics'], 'path: matches the path');
eq(visible('path:page=2'), ['users'], 'path: includes the query string');
eq(visible('path:localhost'), [], 'path: does not look at the host');
eq(visible('url:localhost:4318'), ['traces', 'metrics'], 'url: ignores bodies');
eq(visible('method:post'), ['traces', 'metrics', 'created'], 'method: matches the method');
eq(visible('method:pos'), [], 'method: is an exact match');
eq(visible('-method:get'), ['traces', 'metrics', 'created', 'deleted'], '-method: hides a method');
eq(visible('status:404'), ['deleted'], 'status: exact code');
eq(visible('status:4xx'), ['deleted'], 'status: class with x wildcards');
eq(visible('status:20x'), allBut('deleted', 'upstream', 'slow', 'refused'), 'status: partial wildcard');
eq(visible('status:5'), ['upstream'], 'status: prefix');
eq(visible('status-code:502'), ['upstream'], 'status-code: is status:');
eq(visible('status:error'), ['refused'], 'status:error matches failed requests');
eq(visible('status:pending'), ['slow'], 'status:pending matches in-flight requests');
eq(visible('status:abc'), [], 'status: with a bad value matches nothing');
eq(visible('status:4xxx'), [], 'status: longer than a code matches nothing');
eq(visible('-status:abc'), ALL, '-status: with a bad value hides nothing');
eq(visible('source:http'), ['traces', 'metrics'], 'source: matches the capture wrapper');
eq(
  [row('odd', { url: 'not a url' })].filter((r) => matchesFilter(r, parseFilter('host:not path:url'))).length,
  1,
  'host: and path: fall back to the raw string for an unparseable url'
);

// --- combinations -----------------------------------------------------------
console.log('combinations');
eq(visible('-host:localhost:4318 method:post'), ['created'], 'exclusion + keyed include');
eq(visible('-host:localhost:4318 -host:example.com'), ['config', 'refused'], 'several exclusions');
eq(visible('example.com -status:2xx'), ['deleted', 'upstream', 'slow'], 'free text + keyed exclusion');
eq(visible('-host:localhost:4318 api status:2xx order_id'), ['users'], 'mixed include/exclude/keyed/free text');
eq(visible('method:post method:get'), [], 'contradicting keyed terms match nothing');

// --- odd input never throws -------------------------------------------------
console.log('odd input');
const ODD = [
  '(', '[', '*', '\\', '/(/', '%', '?', ':', '-:', '::::', 'host::::', 'status:%%', 'status:-1',
  ' ', 'é', '😀', 'x'.repeat(10000), 'constructor:x', '__proto__:x', 'toString:x', 'hasOwnProperty:x',
];
let threw = null;
for (const q of ODD) {
  try {
    for (const r of ROWS) {
      if (typeof matchesFilter(r, parseFilter(q)) !== 'boolean') throw new Error('non-boolean result');
    }
  } catch (err) {
    threw = `${JSON.stringify(q.slice(0, 20))}: ${err.message}`;
    break;
  }
}
assert(threw === null, `odd input never throws${threw ? ` (${threw})` : ''}`);
eq(visible('-constructor:x'), ALL, 'constructor:x is plain text');

// --- chips ------------------------------------------------------------------
console.log('chips');
const chips = (methods = [], statuses = [], sources = []) => ({
  methods: new Set(methods),
  statuses: new Set(statuses),
  sources: new Set(sources),
});
const chipped = (f) => ROWS.filter((r) => matchesStructured(r, f)).map((r) => r.name);
eq(chipped(chips()), ALL, 'no chips keep every row');
eq(chipped(chips([], ['4xx', '5xx'])), ['deleted', 'upstream'], 'status chips OR together');
eq(chipped(chips(['POST'], [], ['http'])), ['traces', 'metrics'], 'chip groups AND together');
eq(chipped(chips([], ['error', 'pending'])), ['slow', 'refused'], 'error and pending chips');

// --- seeding from --exclude -------------------------------------------------
console.log('seeding');
eq(exclusionTerm('localhost:4318'), '-url:localhost:4318', 'plain pattern becomes a url exclusion');
eq(exclusionTerm('host:localhost:4318'), '-host:localhost:4318', 'keyed pattern is negated as given');
eq(exclusionTerm('method:OPTIONS'), '-method:OPTIONS', 'keyed pattern keeps its case');
eq(['', '  ', 'a b', '-x', 'host:'].map(exclusionTerm), Array(5).fill(null), 'unusable patterns give null');
eq(withExclusions('', ['localhost:4318']), '-url:localhost:4318', 'seeds an empty filter');
eq(
  withExclusions('method:post', ['localhost:4318', 'status:5xx']),
  '-url:localhost:4318 -status:5xx method:post',
  'goes in front of a saved filter'
);
const once = withExclusions('post', ['localhost:4318', 'method:options']);
eq(withExclusions(once, ['localhost:4318', 'method:options']), once, 'merging twice changes nothing');
eq(withExclusions('-URL:LOCALHOST:4318', ['localhost:4318']), '-URL:LOCALHOST:4318', 'present terms are not repeated');
eq(withExclusions('', ['a', 'a']), '-url:a', 'duplicate patterns are added once');
eq(withExclusions('post ', []), 'post ', 'no patterns leave the filter untouched');
eq(visible(withExclusions('', ['localhost:4318'])), allBut('traces', 'metrics'), 'seed hides only collector traffic');

console.log(failures === 0 ? '\nall assertions passed' : `\n${failures} assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
