/** The collector's in-memory request table. */
import { MAX_ENTRIES, mergeEvent } from '../protocol';
import type { Entry, NetbridgeEvent } from '../protocol';

const PHASES = new Set(['start', 'end', 'error']);

/** True for an object that can be folded into the table. */
export function isEvent(value: unknown): value is NetbridgeEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === 'string' && e.id.length > 0 && PHASES.has(e.phase as string);
}

export class RequestStore {
  private entries = new Map<string, Entry>();

  /** Merge an event into its entry; evicts the oldest entries past the cap. */
  record(event: NetbridgeEvent): Entry {
    const entry = mergeEvent(this.entries.get(event.id), event) as Entry;
    this.entries.set(event.id, entry);
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry;
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

  clear(): void {
    this.entries.clear();
  }
}
