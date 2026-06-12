#!/usr/bin/env node
/**
 * netbridge CLI
 *
 *   netbridge -- <command...>     run a command with HTTP capture enabled
 *   netbridge <command...>        same (the -- is optional)
 *   netbridge init                add a dev:netbridge script to package.json
 *   netbridge --port 4500 -- ...  pick the UI port
 */
import { spawn } from 'child_process';
import * as path from 'path';
import { startCollector } from './server';
import { runInit } from './init';

const DEFAULT_PORT = 4499;

function printHelp(): void {
  console.log(`netbridge — the network tab your server never had

Usage:
  netbridge [--port N] [--] <command...>   run command with HTTP capture
  netbridge init                           add dev:netbridge script to package.json

Examples:
  netbridge -- next dev
  netbridge -- pnpm dev
  netbridge --port 5000 -- node server.js

Environment:
  NETBRIDGE_BODY_LIMIT   max captured body bytes per request (default 262144)
  NETBRIDGE_REDACT=0     disable redaction of auth/cookie headers
  NETBRIDGE_QUIET=1      suppress per-process capture banner`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === 'init') {
    process.exit(runInit(process.cwd()));
  }
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  let port = DEFAULT_PORT;
  let rest = [...argv];
  if (rest[0] === '--port' || rest[0] === '-p') {
    port = Number(rest[1]);
    if (!Number.isInteger(port) || port <= 0) {
      console.error('[netbridge] invalid --port value');
      process.exit(1);
    }
    rest = rest.slice(2);
  }
  if (rest[0] === '--') rest = rest.slice(1);
  if (rest.length === 0) {
    printHelp();
    process.exit(1);
  }

  const collector = await startCollector(port);

  const preloadPath = path.join(__dirname, 'preload.js');
  const existingNodeOptions = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
  const env = {
    ...process.env,
    NODE_OPTIONS: `${existingNodeOptions}--require "${preloadPath}"`,
    NETBRIDGE_PORT: String(collector.port),
  };

  console.log(`\n  netbridge UI  →  http://localhost:${collector.port}\n`);

  const child = spawn(rest[0], rest.slice(1), {
    stdio: 'inherit',
    env,
  });

  child.on('error', (err) => {
    console.error(`[netbridge] failed to start "${rest[0]}":`, err.message);
    collector.close();
    process.exit(1);
  });

  const forward = (signal: NodeJS.Signals) => {
    process.on(signal, () => {
      // Terminal sends the signal to the whole foreground group already; this
      // covers non-tty cases. Never exit before the child does.
      if (child.exitCode === null) child.kill(signal);
    });
  };
  forward('SIGINT');
  forward('SIGTERM');

  child.on('exit', (code, signal) => {
    collector.close();
    if (signal) process.exit(0);
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error('[netbridge]', err.message);
  process.exit(1);
});
