import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapturedRequest, WireEvent } from './types';

/**
 * Hard cap on retained rows. Mirrors the collector's MAX_EVENTS so a long,
 * high-volume session can't grow the client map (and the un-virtualized table)
 * without bound; the oldest rows — which a fresh snapshot would also have
 * dropped — are evicted first.
 */
const MAX_ROWS = 4000;

/** Evict the oldest-inserted (lowest-seq) rows once past the retention cap. */
function trim(map: Map<string, CapturedRequest>): void {
  while (map.size > MAX_ROWS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

interface RequestsState {
  requests: CapturedRequest[];
  live: boolean;
  clearAll: () => Promise<void>;
}

/** Connects to the collector's SSE stream and maintains the request table. */
export function useRequests(): RequestsState {
  const mapRef = useRef<Map<string, CapturedRequest>>(new Map());
  const seqRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const [live, setLive] = useState(false);
  const [requests, setRequests] = useState<CapturedRequest[]>([]);

  const publish = useCallback(() => {
    setRequests([...mapRef.current.values()].sort((a, b) => a.seq - b.seq));
  }, []);

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
    const existing: CapturedRequest =
      map.get(e.id) ?? ({ id: e.id, seq: ++seqRef.current } as CapturedRequest);
    for (const [k, v] of Object.entries(e)) {
      if (v !== undefined && k !== 'phase') (existing as any)[k] = v;
    }
    existing.state =
      e.phase === 'error' ? 'error' : e.phase === 'end' ? 'done' : existing.state || 'pending';
    map.set(e.id, existing);
  }, []);

  useEffect(() => {
    const es = new EventSource('/events');
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.addEventListener('snapshot', (ev) => {
      const list = JSON.parse((ev as MessageEvent).data) as (WireEvent & {
        state?: CapturedRequest['state'];
      })[];
      for (const r of list) {
        const existing = mapRef.current.get(r.id);
        mapRef.current.set(r.id, {
          ...(r as CapturedRequest),
          seq: existing?.seq ?? ++seqRef.current,
          state: (r.state as CapturedRequest['state']) ?? 'pending',
        });
      }
      trim(mapRef.current);
      schedulePublish();
    });
    es.addEventListener('clear', () => {
      mapRef.current.clear();
      seqRef.current = 0;
      schedulePublish();
    });
    es.onmessage = (ev) => {
      applyEvent(JSON.parse(ev.data) as WireEvent);
      trim(mapRef.current);
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

  return { requests, live, clearAll };
}
