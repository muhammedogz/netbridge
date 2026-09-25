// Counts the SIGINT/SIGTERMs it receives, reports them, exits 0 shortly after.
let count = 0;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    count += 1;
    console.log(`[signals] got ${sig} #${count}`);
    setTimeout(() => process.exit(0), 300);
  });
}
console.log('[signals] ready');
// Bounded, in case the test's stop never reaches this process (Windows).
setTimeout(() => process.exit(0), 60_000);
