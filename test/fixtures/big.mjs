// Pulls COUNT responses of KB KiB each from the test origin, a few at a time,
// then stays alive until the test stops netbridge.
const origin = process.env.TARGET_ORIGIN;
const count = Number(process.env.COUNT);
const kb = Number(process.env.KB);
const PARALLEL = 8;

let next = 0;
async function worker() {
  while (next < count) {
    const i = next++;
    await (await fetch(`${origin}/big?kb=${kb}&i=${i}`)).text();
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker));
console.log('[big] all requests done');
// Bounded, in case the test's stop never reaches this process (Windows).
setTimeout(() => process.exit(0), 60_000);
