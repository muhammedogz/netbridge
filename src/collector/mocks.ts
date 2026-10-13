/**
 * Mock rules, collector side: the rule list, the `--mocks` file it is saved
 * to, the stream that keeps every app process's copy current, and the
 * /__mock endpoint that answers http-module calls a rule mocks.
 */
import * as fs from 'fs';
import type * as http from 'http';
import { normalizeMockRule, normalizeMockRules } from '../protocol';
import type { MockRule } from '../protocol';

export class MockStore {
  private rules: MockRule[] = [];
  private streams = new Set<http.ServerResponse>();
  private listeners: ((rules: MockRule[]) => void)[] = [];

  /** Loads `file` when it exists; throws a readable error when it is invalid. */
  constructor(private readonly file?: string) {
    if (!file || !fs.existsSync(file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`mocks file ${file} is not valid JSON: ${(err as Error).message}`);
    }
    const rules = normalizeMockRules(raw);
    if (typeof rules === 'string') throw new Error(`mocks file ${file}: ${rules}`);
    this.rules = rules;
  }

  list(): MockRule[] {
    return this.rules;
  }

  get(id: string): MockRule | undefined {
    return this.rules.find((r) => r.id === id);
  }

  /** Called with the new list after every change. */
  onChange(listener: (rules: MockRule[]) => void): void {
    this.listeners.push(listener);
  }

  replace(raw: unknown): MockRule[] | string {
    const rules = normalizeMockRules(raw);
    if (typeof rules === 'string') return rules;
    this.rules = rules;
    this.changed();
    return rules;
  }

  /** Add a rule, or replace the one with the same id. */
  upsert(raw: unknown): MockRule | string {
    const rule = normalizeMockRule(raw, this.freshId());
    if (typeof rule === 'string') return rule;
    const idx = this.rules.findIndex((r) => r.id === rule.id);
    this.rules = idx >= 0 ? this.rules.map((r, i) => (i === idx ? rule : r)) : [...this.rules, rule];
    this.changed();
    return rule;
  }

  remove(id: string): boolean {
    const next = this.rules.filter((r) => r.id !== id);
    if (next.length === this.rules.length) return false;
    this.rules = next;
    this.changed();
    return true;
  }

  private freshId(): string {
    let n = this.rules.length + 1;
    while (this.rules.some((r) => r.id === `m${n}`)) n += 1;
    return `m${n}`;
  }

  private changed(): void {
    if (this.file) {
      try {
        fs.writeFileSync(this.file, `${JSON.stringify(this.rules, null, 2)}\n`);
      } catch (err) {
        console.error(`[netbridge] could not save mocks to ${this.file}:`, (err as Error).message);
      }
    }
    const line = `${JSON.stringify(this.rules)}\n`;
    for (const res of this.streams) {
      try {
        res.write(line);
      } catch {
        this.streams.delete(res);
      }
    }
    for (const listener of this.listeners) listener(this.rules);
  }

  /** NDJSON stream for the app processes: the full list now and on every change. */
  subscribe(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
    res.write(`${JSON.stringify(this.rules)}\n`);
    this.streams.add(res);
    const drop = () => this.streams.delete(res);
    req.on('close', drop);
    res.on('error', drop);
  }

  /**
   * Answer an http-module call that a rule mocks (see capture/http.ts). A
   * fail rule's call is held open: the app process destroys it with the
   * rule's error after the delay.
   */
  serve(id: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    req.resume();
    const rule = this.get(id);
    if (rule?.fail) {
      // Safety net in case the app process never cuts the call.
      const t = setTimeout(() => res.destroy(), (rule.delayMs ?? 0) + 30_000);
      res.on('close', () => clearTimeout(t));
      return;
    }
    const response = rule?.response;
    if (!response) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `netbridge mock rule ${id} no longer exists` }));
      return;
    }
    const send = () => {
      if (res.destroyed) return;
      try {
        const body =
          response.body == null
            ? undefined
            : Buffer.from(response.body, response.bodyEncoding === 'base64' ? 'base64' : 'utf8');
        res.writeHead(response.status, response.headers ?? {});
        res.end(body);
      } catch {
        // A rule that Node can't send (it runs inside a timer here, where a
        // throw would take the collector down): cut the call instead.
        res.destroy();
      }
    };
    if (!rule.delayMs) {
      send();
      return;
    }
    const t = setTimeout(send, rule.delayMs);
    res.on('close', () => clearTimeout(t));
  }
}
