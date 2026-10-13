/**
 * Request correlation. AsyncLocalStorage follows an inbound request's handler
 * through awaits, timers and promise chains, so an outbound call made while
 * handling it can name it as its parent, with no help from the app.
 */
import { AsyncLocalStorage } from 'async_hooks';

export interface InboundContext {
  id: string;
  /** Records the inbound entry; called on its first outbound call. */
  open(): void;
}

const inbound = new AsyncLocalStorage<InboundContext>();

export function runInbound<T>(ctx: InboundContext, fn: () => T): T {
  return inbound.run(ctx, fn);
}

/** Id of the inbound request being handled here, if any. */
export function currentParent(): string | undefined {
  const ctx = inbound.getStore();
  if (!ctx) return undefined;
  ctx.open();
  return ctx.id;
}

// Node's fetch is built on undici, so its calls also show up on undici's
// diagnostics channels. The fetch wrapper marks its own calls; the undici
// listener skips them instead of recording them twice.
const inFetch = new AsyncLocalStorage<boolean>();

export function runInFetch<T>(fn: () => T): T {
  return inFetch.run(true, fn);
}

export function isInFetch(): boolean {
  return inFetch.getStore() === true;
}
