import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapturedRequest, WireEvent } from './types';

interface RequestsState {
  requests: CapturedRequest[];
  live: boolean;
  clearAll: () => Promise<void>;
}

/** Connects to the collector's SSE stream and maintains the request table. */
export function useRequests(): RequestsState {
  const mapRef = useRef<Map<string, CapturedRequest>>(new Map());
  const seqRef = useRef(0);
  const [live, setLive] = useState(false);
  const [requests, setRequests] = useState<CapturedRequest[]>([]);

  const publish = useCallback(() => {
    setRequests([...mapRef.current.values()].sort((a, b) => a.seq - b.seq));
  }, []);

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
      publish();
    });
    es.addEventListener('clear', () => {
      mapRef.current.clear();
      seqRef.current = 0;
      publish();
    });
    es.onmessage = (ev) => {
      applyEvent(JSON.parse(ev.data) as WireEvent);
      publish();
    };
    return () => es.close();
  }, [applyEvent, publish]);

  const clearAll = useCallback(async () => {
    await fetch('/api/clear', { method: 'POST' });
    mapRef.current.clear();
    seqRef.current = 0;
    publish();
  }, [publish]);

  return { requests, live, clearAll };
}
