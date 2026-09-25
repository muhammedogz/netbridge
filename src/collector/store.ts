/** The collector's in-memory request table. */
import { DEFAULT_BUFFER_LIMIT, MAX_ENTRIES, entrySize, mergeEvent } from '../protocol';
import type { Entry, NetbridgeEvent } from '../protocol';

const PHASES = new Set(['start', 'end', 'error']);

/** True for an object that can be folded into the table. */
export function isEvent(value: unknown): value is NetbridgeEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === 'string' && e.id.length > 0 && PHASES.has(e.phase as string);
}

/**
 * Entries in arrival order, bounded by count and by total size: past either
 * limit the oldest go first. The newest entry always stays, however large.
 */
export class RequestStore {
  private entries = new Map<string, Entry>();
  private sizes = new Map<string, number>();
  private bytes = 0;

  constructor(
    readonly maxBytes = DEFAULT_BUFFER_LIMIT,
    readonly maxEntries = MAX_ENTRIES
  ) {}

  /** Merge an event into its entry, then evict past the limits. */
  record(event: NetbridgeEvent): Entry {
    const entry = mergeEvent(this.entries.get(event.id), event) as Entry;
    this.entries.set(event.id, entry);
    const size = entrySize(entry);
    this.bytes += size - (this.sizes.get(event.id) ?? 0);
    this.sizes.set(event.id, size);
    while (this.entries.size > 1 && (this.entries.size > this.maxEntries || this.bytes > this.maxBytes)) {
      const oldest = this.entries.keys().next().value as string;
      this.delete(oldest);
    }
    return entry;
  }

  private delete(id: string): void {
    this.bytes -= this.sizes.get(id) ?? 0;
    this.sizes.delete(id);
    this.entries.delete(id);
  }

  get(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  values(): Entry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  /** Approximate retained size, see entrySize(). */
  get retainedBytes(): number {
    return this.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.sizes.clear();
    this.bytes = 0;
  }
}
