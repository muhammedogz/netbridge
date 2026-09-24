/**
 * CLI behavior: --exclude reaching the UI config, option validation, and port
 * collision handling.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import http from 'http';
import path from 'path';
import { CLI, FIXTURES, runCli, settled, startOrigin } from './helpers.mjs';

let origin;
before(async () => {
  origin = await startOrigin();
});
after(async () => {
  await origin?.close();
});

describe('--exclude', () => {
  it('seeds the UI config without affecting capture', async () => {
    const EXCLUDE = ['/gzip', 'method:options'];
    const nb = await runCli({
      args: ['--exclude', EXCLUDE[0], '--exclude', EXCLUDE[1]],
      command: [process.execPath, path.join(FIXTURES, 'basic.mjs')],
      env: { TARGET_ORIGIN: origin.url },
    });
    try {
      const config = await (await fetch(`${nb.base}/api/config`)).json();
      assert.deepEqual(config.exclude, EXCLUDE);
      assert.equal(typeof config.startedAt, 'number');
      const list = await nb.waitForRequests((l) => l.length >= 5 && l.every(settled));
      assert.ok(list.some((r) => r.url.endsWith('/gzip')), 'excluded request still captured');
    } finally {
      await nb.stop();
    }
  });

  it('rejects a missing pattern', () => {
    const r = spawnSync(process.execPath, [CLI, '--exclude', '--', process.execPath, '-e', '0'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--exclude/);
  });
});

describe('--port', () => {
  it('rejects an invalid value', () => {
    const r = spawnSync(process.execPath, [CLI, '--port', 'abc', '--', process.execPath, '-e', '0'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--port/);
  });

  it('moves past a busy port and sends events only to its own collector', async () => {
    let leakedIngests = 0;
    const blocker = http.createServer((req, res) => {
      if (req.url === '/ingest') leakedIngests += 1;
      res.writeHead(204).end();
    });
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = blocker.address().port;
    const nb = await runCli({
      args: ['--port', String(busy)],
      command: [process.execPath, path.join(FIXTURES, 'basic.mjs')],
      env: { TARGET_ORIGIN: origin.url },
    });
    try {
      assert.notEqual(nb.port, busy, 'printed url uses the real port');
      await nb.waitForRequests((l) => l.length >= 4);
      assert.equal(leakedIngests, 0, 'no events leaked to the busy port');
    } finally {
      await nb.stop();
      blocker.close();
    }
  });
});
