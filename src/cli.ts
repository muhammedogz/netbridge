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
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { startCollector } from './server';
import { detectProject, runInit } from './init';

const DEFAULT_PORT = 4499;

function printHelp(): void {
  console.log(`netbridge — the network tab your server never had

Usage:
  netbridge [--port N] [--] <command...>   run command with HTTP capture
  netbridge                                pick what to run interactively (TTY)
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

// ---------------------------------------------------------------------------
// Interactive start — bare `netbridge` on a terminal asks what to run instead
// of dumping help. Offers the project's package.json scripts (netbridge-
// wrapping ones excluded to avoid recursion) or any free-form command.
// ---------------------------------------------------------------------------

const MAX_CHOICES = 9;

function runnableScripts(cwd: string): { name: string; command: string }[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return Object.entries(pkg.scripts ?? {})
      .filter((e): e is [string, string] => typeof e[1] === 'string' && !/\bnetbridge\b/.test(e[1]))
      .map(([name, command]) => ({ name, command }));
  } catch {
    return [];
  }
}

/** rl.question that resolves null when stdin closes (Ctrl+C / Ctrl+D). */
function askLine(rl: readline.Interface, query: string): Promise<string | null> {
  return new Promise((resolve) => {
    const onClose = () => resolve(null);
    rl.once('close', onClose);
    rl.question(query, (answer) => {
      rl.removeListener('close', onClose);
      resolve(answer);
    });
  });
}

async function promptForCommand(cwd: string): Promise<string | null> {
  const { packageManager } = detectProject(cwd);
  const runPrefix =
    packageManager === 'yarn' ? 'yarn' : packageManager === 'bun' ? 'bun run' : `${packageManager} run`;
  const scripts = runnableScripts(cwd)
    // `dev` first — it is what people almost always want to wrap.
    .sort((a, b) => Number(b.name === 'dev') - Number(a.name === 'dev'))
    .slice(0, MAX_CHOICES);

  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  console.log('netbridge — what should it run?\n');
  scripts.forEach((s, i) => {
    console.log(`  ${i + 1}) ${runPrefix} ${s.name}  ${dim(`— ${s.command}`)}`);
  });
  console.log(
    scripts.length
      ? `\n  …or type any command ${dim('(e.g. node server.js)')}`
      : `  no package.json scripts found here — type the command to run ${dim('(e.g. node server.js)')}`
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => rl.close());
  try {
    for (;;) {
      const hint = scripts.length ? ' [1]' : '';
      const answer = await askLine(rl, `\n› command${hint}: `);
      if (answer === null) return null;
      const trimmed = answer.trim();
      if (!trimmed) {
        if (scripts.length) return `${runPrefix} ${scripts[0].name}`;
        continue;
      }
      if (/^\d+$/.test(trimmed)) {
        const idx = Number(trimmed) - 1;
        if (idx >= 0 && idx < scripts.length) return `${runPrefix} ${scripts[idx].name}`;
        console.log(scripts.length ? `  pick 1–${scripts.length}, or type a command` : '  type a command');
        continue;
      }
      return trimmed;
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === 'init') {
    process.exit(runInit(process.cwd()));
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  let port = DEFAULT_PORT;
  let rest = [...argv];
  if (rest[0] === '--port' || rest[0] === '-p') {
    port = Number(rest[1]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error('[netbridge] invalid --port value');
      process.exit(1);
    }
    rest = rest.slice(2);
  }
  if (rest[0] === '--') rest = rest.slice(1);

  // A prompted command arrives as one string and is run through the shell,
  // which handles arg splitting and quoting; argv commands stay exact.
  let shellCommand: string | null = null;
  if (rest.length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      shellCommand = await promptForCommand(process.cwd());
      if (shellCommand === null) process.exit(130);
    } else {
      printHelp();
      process.exit(1);
    }
  }

  const collector = await startCollector(port);

  const preloadPath = path.join(__dirname, 'preload.js');
  const existingNodeOptions = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
  const env = {
    ...process.env,
    NODE_OPTIONS: `${existingNodeOptions}--require "${preloadPath}"`,
    NETBRIDGE_PORT: String(collector.port),
  };

  if (shellCommand) console.log(`\n  running: ${shellCommand}`);
  console.log(`\n  netbridge UI  →  http://localhost:${collector.port}\n`);

  const child = shellCommand
    ? spawn(shellCommand, { stdio: 'inherit', env, shell: true })
    : spawn(rest[0], rest.slice(1), {
        stdio: 'inherit',
        env,
        // On Windows a bare command like `next`/`pnpm` resolves to a `.cmd` shim
        // that is only runnable through a shell — without this, spawn ENOENTs.
        // POSIX keeps shell:false so signals and arg passing stay exact.
        shell: process.platform === 'win32',
      });

  child.on('error', (err) => {
    console.error(`[netbridge] failed to start "${shellCommand ?? rest[0]}":`, err.message);
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
