import type { Entry, NetbridgeEvent } from '../../src/protocol';

export type { ViewConfig } from '../../src/protocol';

/** An entry as the UI keeps it: `seq` orders rows by first sighting. */
export type CapturedRequest = Entry & { seq: number };

/** A live SSE event: a capture event, possibly partial. */
export type WireEvent = Partial<NetbridgeEvent> & { id: string };
