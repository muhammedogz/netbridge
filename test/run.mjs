// Runs every test/*.test.mjs under node:test. A script rather than a glob so
// it behaves the same on every supported Node version and on Windows shells.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs') && (only.length === 0 || only.some((o) => f.includes(o))))
  .sort()
  .map((f) => path.join(dir, f));

const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
