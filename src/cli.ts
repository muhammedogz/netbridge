#!/usr/bin/env node
/**
 * netbridge CLI
 *
 *   netbridge -- <command...>     run a command with HTTP capture enabled
 *   netbridge <command...>        same (the -- is optional)
 *   netbridge init                add a dev:netbridge script to package.json
 *   netbridge --port 4500 -- ...  pick the UI port
 *   netbridge --exclude X -- ...  start the UI with urls containing X hidden
 */
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import { constants as osConstants } from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { startCollector } from './collector';
import { detectProject, runInit, runScriptCommand } from './init';

const DEFAULT_PORT = 4499;

function printHelp(): void {
  console.log(`netbridge — the network tab your server never had

Usage:
  netbridge [options] [--] <command...>   run command with HTTP capture
  netbridge [options]                     pick what to run interactively (TTY)
  netbridge init                          add dev:netbridge script to package.json

Options:
  -p, --port N           UI port (default ${DEFAULT_PORT}, next free one if busy;
                         0 picks any free port)
  --exclude PATTERN      open the UI with requests whose url contains PATTERN
                         hidden; also takes filter terms such as method:options.
                         Repeatable. View only: everything is still captured.

Examples:
  netbridge -- next dev
  netbridge -- pnpm dev
  netbridge --port 5000 -- node server.js
  netbridge --exclude localhost:4318 -- pnpm dev

Environment:
  NETBRIDGE_BODY_LIMIT   max captured body bytes per request (default 262144)
  NETBRIDGE_BUFFER_LIMIT total bodies+headers kept before the oldest requests
                         are dropped (default 268435456, i.e. 256 MB)
  NETBRIDGE_REDACT=0     disable redaction of auth/cookie headers
  NETBRIDGE_QUIET=1      suppress per-process capture banner`);
}

/**
 * Quote a value for NODE_OPTIONS. Node's parser treats a backslash inside
 * double quotes as an escape, so a Windows path (C:\Users\...) must have its
 * backslashes doubled or it resolves to a file that doesn't exist.
 */
function quoteNodeOption(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
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
  const run = (name: string) => runScriptCommand(packageManager, name);
  const scripts = runnableScripts(cwd)
    // `dev` first — it is what people almost always want to wrap.
    .sort((a, b) => Number(b.name === 'dev') - Number(a.name === 'dev'))
    .slice(0, MAX_CHOICES);

  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  console.log('netbridge — what should it run?\n');
  scripts.forEach((s, i) => {
    console.log(`  ${i + 1}) ${run(s.name)}  ${dim(`— ${s.command}`)}`);
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
        if (scripts.length) return run(scripts[0].name);
        continue;
      }
      if (/^\d+$/.test(trimmed)) {
        const idx = Number(trimmed) - 1;
        if (idx >= 0 && idx < scripts.length) return run(scripts[idx].name);
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
  const exclude: string[] = [];
  let rest = [...argv];
  // Options come first, in any order; the command starts at `--` or at the
  // first word that isn't one of them.
  for (;;) {
    if (rest[0] === '--port' || rest[0] === '-p') {
      port = Number(rest[1]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error('[netbridge] invalid --port value');
        process.exit(1);
      }
      rest = rest.slice(2);
    } else if (rest[0] === '--exclude') {
      const pattern = rest[1];
      // A single filter term: a leading "-" means the value is missing (or
      // would read as a double negation), whitespace would split it in two.
      if (!pattern || pattern.startsWith('-') || /\s/.test(pattern)) {
        console.error('[netbridge] invalid --exclude value (one pattern, no spaces), e.g. --exclude localhost:4318');
        process.exit(1);
      }
      exclude.push(pattern);
      rest = rest.slice(2);
    } else {
      break;
    }
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

  // Per-run secret: only processes launched here can post to /ingest.
  const token = randomBytes(24).toString('hex');
  const bufferLimit = Number(process.env.NETBRIDGE_BUFFER_LIMIT) || undefined;
  const collector = await startCollector(port, { exclude, token, bufferLimit });

  const existingNodeOptions = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
  const env = {
    ...process.env,
    NODE_OPTIONS: `${existingNodeOptions}--require ${quoteNodeOption(path.join(__dirname, 'preload.js'))}`,
    NETBRIDGE_PORT: String(collector.port),
    NETBRIDGE_TOKEN: token,
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

  // Never exit before the child does: handle the signal here and pass it on.
  // Ctrl+C in a terminal already reaches the child directly (it is in the
  // same foreground process group), and many dev servers read a second
  // SIGINT as "force quit", so SIGINT is only forwarded off-terminal (a
  // parent tool or `kill` signalling netbridge alone). Terminals never send
  // SIGTERM, so it is always forwarded.
  const interactive = Boolean(process.stdin.isTTY);
  process.on('SIGINT', () => {
    if (!interactive && child.exitCode === null) child.kill('SIGINT');
  });
  process.on('SIGTERM', () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  child.on('exit', (code, signal) => {
    collector.close();
    // A child killed by a signal reports it the shell way (SIGTERM → 143), so
    // scripts and CI see the failure instead of a success.
    process.exit(signal ? 128 + (osConstants.signals[signal] ?? 0) : (code ?? 0));
  });
}

main().catch((err) => {
  console.error('[netbridge]', err.message);
  process.exit(1);
});
