// Real-world HTTP clients against the test origin (TARGET_ORIGIN). Each call
// tags its url with ?client=<name> so the test can find it.
import axios from 'axios';
import got from 'got';
import ky from 'ky';
import nodeFetch from 'node-fetch';

const origin = process.env.TARGET_ORIGIN;
const u = (route, client) => `${origin}${route}?client=${client}`;

await axios.get(u('/gzip', 'axios'));
await axios.post(u('/echo', 'axios-post'), { from: 'axios' });
await got(u('/gzip', 'got')).json();
await got.post(u('/echo', 'got-post'), { json: { from: 'got' } }).json();
await ky.get(u('/json', 'ky')).json();
await ky.post(u('/echo', 'ky-post'), { json: { from: 'ky' } }).json();
await (await nodeFetch(u('/gzip', 'node-fetch'))).json();

console.log('[clients] all requests done');
setInterval(() => {}, 60_000);
