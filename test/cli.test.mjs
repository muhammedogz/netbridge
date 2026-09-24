/**
 * CLI behavior: --exclude reaching the UI config, option validation, port
 * collision handling, exit status, signal forwarding and preload install.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { CLI, FIXTURES, ROOT, runCli, settled, startOrigin, waitFor } from './helpers.mjs';

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

describe('exit status', () => {
  it("passes the command's exit code through", async () => {
    const nb = await runCli({ command: [process.execPath, '-e', 'process.exit(3)'], waitForUrl: false });
    assert.equal((await nb.exited).code, 3);
  });

  it('exits 128+n when the command is killed by a signal', { skip: process.platform === 'win32' }, async () => {
    const nb = await runCli({
      command: [process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"],
      waitForUrl: false,
    });
    assert.equal((await nb.exited).code, 143);
  });
});

describe('signals', { skip: process.platform === 'win32' }, () => {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    it(`forwards ${sig} exactly once when not run from a terminal`, async () => {
      const nb = await runCli({ command: [process.execPath, path.join(FIXTURES, 'signals.mjs')] });
      await waitFor(() => nb.output.includes('[signals] ready'));
      nb.child.kill(sig);
      const { code } = await nb.exited;
      assert.equal(code, 0);
      assert.equal(nb.output.match(/\[signals\] got/g)?.length, 1, nb.output);
    });
  }
});

describe('preload path', () => {
  // NODE_OPTIONS treats a backslash inside quotes as an escape, so an
  // unescaped Windows path (C:\Users\...) never loads. Linux can hold the same
  // characters in a directory name, so install a copy of the package there.
  it('loads from a path with backslashes, spaces and quotes', { skip: process.platform === 'win32' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb \\ "quoted" '));
    try {
      for (const part of ['dist', 'ui', 'package.json']) {
        fs.cpSync(path.join(ROOT, part), path.join(dir, part), { recursive: true });
      }
      const nb = await runCli({
        cli: path.join(dir, 'dist', 'cli.js'),
        command: [process.execPath, path.join(FIXTURES, 'basic.mjs')],
        env: { TARGET_ORIGIN: origin.url },
      });
      try {
        const list = await nb.waitForRequests((l) => l.length >= 5 && l.every(settled));
        assert.ok(list.length >= 5);
      } finally {
        await nb.stop();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('arguments', () => {
  it('reach the command exactly, spaces and quotes included', async () => {
    const args = ['a b', 'say "hi"', 'x&y', ''];
    const nb = await runCli({
      command: [process.execPath, '-e', 'console.log("ARGV=" + JSON.stringify(process.argv.slice(1)))', ...args],
      waitForUrl: false,
    });
    await nb.exited;
    assert.ok(nb.output.includes(`ARGV=${JSON.stringify(args)}`), nb.output);
  });
});
