/** Serves the built web UI (the package's ui/ directory). */
import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';

const UI_DIR = path.join(__dirname, '..', '..', 'ui');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.json': 'application/json',
};

/** Serve a file from the UI build; false when there is no such file. */
export function serveStatic(urlPath: string, res: http.ServerResponse): boolean {
  const clean = urlPath.split('?')[0];
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const file = path.normalize(path.join(UI_DIR, rel));
  // Trailing separator: a bare prefix check also matches a sibling like
  // `<uiDir>-secret`, so require the path to live strictly *inside* uiDir.
  if (!file.startsWith(UI_DIR + path.sep)) return false; // no traversal
  let content: Buffer;
  try {
    content = fs.readFileSync(file);
  } catch {
    return false;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
  res.end(content);
  return true;
}
