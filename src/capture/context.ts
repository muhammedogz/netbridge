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
  /** When the response closed, then pushed forward by each call made after it. */
  idleSince?: number;
}

/**
 * Work that follows the response (Next's after(), a log flush) still belongs
 * to the request. A call made this long after the response and the request's
 * previous call does not: it comes from a timer the request merely happened
 * to schedule, such as an OpenTelemetry batch export, which would otherwise
 * be pinned to whichever request first started it.
 */
export const AFTER_RESPONSE_GRACE_MS = 2000;

const inbound = new AsyncLocalStorage<InboundContext>();

export function runInbound<T>(ctx: InboundContext, fn: () => T): T {
  return inbound.run(ctx, fn);
}

/** Id of the inbound request being handled here, if any. */
export function currentParent(): string | undefined {
  const ctx = inbound.getStore();
  if (!ctx) return undefined;
  if (ctx.idleSince !== undefined) {
    const now = Date.now();
    if (now - ctx.idleSince > AFTER_RESPONSE_GRACE_MS) return undefined;
    ctx.idleSince = now;
  }
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
