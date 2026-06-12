/**
 * `netbridge init` — detects the project's package manager and dev command,
 * then adds a "dev:netbridge" script to package.json.
 */
import * as fs from 'fs';
import * as path from 'path';

interface Detection {
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm';
  framework: string;
  devCommand: string | null;
}

export function detectProject(cwd: string): Detection {
  const has = (file: string) => fs.existsSync(path.join(cwd, file));

  const packageManager = has('pnpm-lock.yaml')
    ? 'pnpm'
    : has('yarn.lock')
      ? 'yarn'
      : has('bun.lockb') || has('bun.lock')
        ? 'bun'
        : 'npm';

  let framework = 'node';
  let devCommand: string | null = null;

  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) framework = 'next';
    else if (deps.nuxt) framework = 'nuxt';
    else if (deps['@remix-run/node'] || deps['@react-router/node']) framework = 'remix';
    else if (deps.astro) framework = 'astro';
    else if (deps.express) framework = 'express';
    else if (deps.fastify) framework = 'fastify';

    if (pkg.scripts?.dev) {
      const runPrefix =
        packageManager === 'yarn'
          ? 'yarn'
          : packageManager === 'bun'
            ? 'bun run'
            : `${packageManager} run`;
      devCommand = `${runPrefix} dev`;
    }
  }

  return { packageManager, framework, devCommand };
}

export function runInit(cwd: string): number {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error('[netbridge] no package.json found in', cwd);
    return 1;
  }

  const detection = detectProject(cwd);
  if (!detection.devCommand) {
    console.error(
      '[netbridge] no "dev" script found in package.json — add one, or run directly:\n' +
        '  npx netbridge -- <your dev command>'
    );
    return 1;
  }

  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  pkg.scripts = pkg.scripts || {};

  if (pkg.scripts['dev:netbridge']) {
    console.log('[netbridge] "dev:netbridge" script already exists — nothing to do.');
    return 0;
  }

  pkg.scripts['dev:netbridge'] = `netbridge -- ${detection.devCommand}`;

  // Preserve trailing newline style of the original file.
  const trailing = raw.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + trailing);

  console.log(`[netbridge] detected: ${detection.framework} project using ${detection.packageManager}`);
  console.log(`[netbridge] added script  "dev:netbridge": "netbridge -- ${detection.devCommand}"`);
  console.log(`[netbridge] run it with:  ${detection.packageManager} run dev:netbridge`);
  return 0;
}
