/**
 * Call trees in the UI: which outbound calls each inbound request made, which
 * of them repeat, and the row order that shows each call under its request.
 */
import { callKey } from '../../src/protocol';
import type { CapturedRequest } from './types';

export interface Tree {
  /** Inbound id → the calls made while handling it, in arrival order. */
  children: Map<string, CapturedRequest[]>;
  /** Call id → how often the same call occurs under the same parent (≥ 2). */
  repeats: Map<string, number>;
}

// The tree is rebuilt on every published frame. Entries are updated in place,
// so a key is reused while the method, url and body it was made from stand.
const keys = new WeakMap<CapturedRequest, { method: string; url: string; body?: string; key: string }>();

function cachedKey(r: CapturedRequest): string {
  const hit = keys.get(r);
  if (hit && hit.body === r.reqBody && hit.url === r.url && hit.method === r.method) return hit.key;
  const key = callKey(r);
  keys.set(r, { method: r.method, url: r.url, body: r.reqBody, key });
  return key;
}

/**
 * `key` tells calls apart for the repeat count; the default reads the request
 * body, entries from a summary list carry a precomputed one.
 */
export function buildTree(
  requests: readonly CapturedRequest[],
  key: (r: CapturedRequest) => string = cachedKey
): Tree {
  const children = new Map<string, CapturedRequest[]>();
  for (const r of requests) {
    if (!r.parentId) continue;
    let list = children.get(r.parentId);
    if (!list) children.set(r.parentId, (list = []));
    list.push(r);
  }
  const repeats = new Map<string, number>();
  for (const list of children.values()) {
    if (list.length < 2) continue;
    const byKey = new Map<string, CapturedRequest[]>();
    for (const c of list) {
      const k = key(c);
      let same = byKey.get(k);
      if (!same) byKey.set(k, (same = []));
      same.push(c);
    }
    for (const same of byKey.values()) {
      if (same.length > 1) for (const c of same) repeats.set(c.id, same.length);
    }
  }
  return { children, repeats };
}

export interface Row {
  r: CapturedRequest;
  /** 1 for a call shown under its inbound request. */
  depth: 0 | 1;
}

/**
 * Rows in arrival order. Grouped, each inbound request is followed by its
 * calls (unless collapsed); a call whose request is filtered out stays at
 * its own place. Flat, every entry is a row of its own; `showInbound: false`
 * leaves out the inbound requests themselves.
 */
export function toRows(
  filtered: readonly CapturedRequest[],
  tree: Tree,
  grouped: boolean,
  collapsed: ReadonlySet<string>,
  showInbound = true
): Row[] {
  if (!grouped) {
    const list = showInbound ? filtered : filtered.filter((r) => r.source !== 'inbound');
    return list.map((r) => ({ r, depth: 0 }));
  }
  const visible = new Set(filtered.map((r) => r.id));
  const rows: Row[] = [];
  for (const r of filtered) {
    if (r.parentId && visible.has(r.parentId)) continue;
    rows.push({ r, depth: 0 });
    if (r.source !== 'inbound' || collapsed.has(r.id)) continue;
    for (const c of tree.children.get(r.id) ?? []) if (visible.has(c.id)) rows.push({ r: c, depth: 1 });
  }
  return rows;
}
