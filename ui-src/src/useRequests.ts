import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_BUFFER_LIMIT, MAX_ENTRIES, entrySize, graphqlFields, mergeEvent } from '../../src/protocol';
import type { MockRule } from '../../src/protocol';
import type { CapturedRequest, WireEvent } from './types';

/**
 * Retention mirrors the collector: at most MAX_ENTRIES rows and `limit`
 * characters of bodies and headers, so a long, high-volume session can't grow
 * the client map (and the un-virtualized table) without bound. The oldest
 * rows, which a fresh snapshot would also have dropped, go first.
 */
/** Fill in what the UI derives from an entry's bodies (GraphQL operations, errors). */
function derive(r: CapturedRequest): void {
  if (!r.method || !r.url) return;
  const { gql, gqlErrors } = graphqlFields(r);
  r.gql = gql;
  r.gqlErrors = gqlErrors;
}

function trim(map: Map<string, CapturedRequest>, limit: number): void {
  let bytes = 0;
  for (const r of map.values()) bytes += entrySize(r);
  for (const [id, r] of map) {
    if (map.size <= 1 || (map.size <= MAX_ENTRIES && bytes <= limit)) break;
    bytes -= entrySize(r);
    map.delete(id);
  }
}

interface RequestsState {
  requests: CapturedRequest[];
  live: boolean;
  clearAll: () => Promise<void>;
  /** The collector's mock rules, kept current over the same stream. */
  mocks: MockRule[];
}

/** Connects to the collector's SSE stream and maintains the request table. */
export function useRequests(bufferLimit = DEFAULT_BUFFER_LIMIT): RequestsState {
  const mapRef = useRef<Map<string, CapturedRequest>>(new Map());
  const seqRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const [live, setLive] = useState(false);
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [mocks, setMocks] = useState<MockRule[]>([]);

  const publish = useCallback(() => {
    // Once per frame, not per event: sizing the table is O(rows).
    trim(mapRef.current, bufferLimit);
    setRequests([...mapRef.current.values()].sort((a, b) => a.seq - b.seq));
  }, [bufferLimit]);

  // Coalesce bursts of SSE events into a single render per animation frame.
  // The map stays authoritative, so no events are dropped — only the redundant
  // O(n log n) sort + setState that the old per-event publish ran on every
  // message (which froze the tab under hundreds of events/sec).
  const schedulePublish = useCallback(() => {
    if (frameRef.current != null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      publish();
    });
  }, [publish]);

  const applyEvent = useCallback((e: WireEvent) => {
    const map = mapRef.current;
    const existing = map.get(e.id) ?? ({ id: e.id, seq: ++seqRef.current } as CapturedRequest);
    const merged = mergeEvent(existing, e);
    // Bodies come with the start (request) and the end (response) events.
    if (e.reqBody !== undefined || e.resBody !== undefined || e.phase === 'start') derive(merged);
    map.set(e.id, merged);
  }, []);

  useEffect(() => {
    const es = new EventSource('/events');
    es.onopen = () => {
      setLive(true);
      // Changes while disconnected arrive with no event: fetch the list.
      fetch('/api/mocks')
        .then((res) => (res.ok ? res.json() : []))
        .then(setMocks)
        .catch(() => {});
    };
    es.addEventListener('mocks', (ev) => setMocks(JSON.parse((ev as MessageEvent).data)));
    es.onerror = () => setLive(false);
    es.addEventListener('snapshot', (ev) => {
      const list = JSON.parse((ev as MessageEvent).data) as (WireEvent & {
        state?: CapturedRequest['state'];
      })[];
      for (const r of list) {
        const existing = mapRef.current.get(r.id);
        const entry: CapturedRequest = {
          ...(r as CapturedRequest),
          seq: existing?.seq ?? ++seqRef.current,
          state: (r.state as CapturedRequest['state']) ?? 'pending',
        };
        if (entry.method && entry.url) derive(entry);
        mapRef.current.set(r.id, entry);
      }
      schedulePublish();
    });
    es.addEventListener('clear', () => {
      mapRef.current.clear();
      seqRef.current = 0;
      schedulePublish();
    });
    es.onmessage = (ev) => {
      applyEvent(JSON.parse(ev.data) as WireEvent);
      schedulePublish();
    };
    return () => {
      es.close();
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [applyEvent, schedulePublish]);

  const clearAll = useCallback(async () => {
    await fetch('/api/clear', { method: 'POST' });
    mapRef.current.clear();
    seqRef.current = 0;
    schedulePublish();
  }, [schedulePublish]);

  return { requests, live, clearAll, mocks };
}
