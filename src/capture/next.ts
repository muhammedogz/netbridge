/**
 * Next.js server actions arrive as a POST carrying only an action id. The
 * build manifest maps that id to the exported function and its file; the
 * dev server keeps it under .next/dev (Next 16) or .next (earlier, and
 * production builds), next to where the server runs.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ServerAction } from '../protocol';

const MANIFESTS = [
  path.join('.next', 'dev', 'server', 'server-reference-manifest.json'),
  path.join('.next', 'server', 'server-reference-manifest.json'),
];

type Manifest = Record<string, { exportedName?: unknown; filename?: unknown }>;

// Reread only when a manifest changes: the dev server rewrites it as you edit.
const cache = new Map<string, { mtimeMs: number; node: Manifest }>();

function load(file: string): Manifest | undefined {
  try {
    const { mtimeMs } = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.node;
    const node = (JSON.parse(fs.readFileSync(file, 'utf8')) as { node?: Manifest }).node ?? {};
    cache.set(file, { mtimeMs, node });
    return node;
  } catch {
    return undefined;
  }
}

export function serverAction(id: string): ServerAction {
  for (const rel of MANIFESTS) {
    const entry = load(path.join(process.cwd(), rel))?.[id];
    if (!entry) continue;
    return {
      id,
      ...(typeof entry.exportedName === 'string' ? { name: entry.exportedName } : {}),
      ...(typeof entry.filename === 'string' ? { file: entry.filename } : {}),
    };
  }
  return { id };
}
