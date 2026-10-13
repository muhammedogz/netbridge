import { useState } from 'react';
import type { CapturedRequest } from '../types';
import { CopyButton } from './CopyButton';

/**
 * Where a response's time went: waiting for the headers, then the body. For
 * a body that came in pieces (a stream, a large download), a strip with one
 * tick per piece on the same time axis.
 */
export function TimingSection({ r }: { r: CapturedRequest }) {
  const chunks = r.resChunks;
  if (r.ttfbMs == null && !chunks) return null;
  const end = Math.max(r.durationMs ?? 0, chunks?.[chunks.length - 1]?.[0] ?? 0, r.ttfbMs ?? 0) || 1;
  const x = (ms: number) => `${(ms / end) * 100}%`;
  const maxBytes = chunks ? Math.max(...chunks.map(([, b]) => b)) : 1;
  const total = chunks?.reduce((sum, [, b]) => sum + b, 0) ?? 0;

  return (
    <div className="section">
      <div className="sec-head">
        <h3>timing</h3>
      </div>
      <div className="timing-line">
        {r.ttfbMs != null && <span title="time to first byte: until the response headers came in">waiting {r.ttfbMs} ms</span>}
        {r.ttfbMs != null && r.durationMs != null && <span>body {r.durationMs - r.ttfbMs} ms</span>}
        {r.ttfbMs != null && r.durationMs == null && <span className="pending">body arriving…</span>}
        {chunks && (
          <span title="pieces of the body as they came off the wire">
            {chunks.length} pieces · {total} B · first after {chunks[0][0]} ms, last after{' '}
            {chunks[chunks.length - 1][0]} ms
          </span>
        )}
      </div>
      {chunks && (
        <svg className="chunk-strip" role="img" aria-label="when each piece of the body arrived">
          {r.ttfbMs != null && <rect className="chunk-wait" x="0" y="0" width={x(r.ttfbMs)} height="100%" />}
          {chunks.map(([at, bytes], i) => {
            const h = Math.max(15, Math.sqrt(bytes / maxBytes) * 100);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: points never reorder
              <rect key={i} className="chunk" x={x(at)} y={`${100 - h}%`} width="2" height={`${h}%`}>
                <title>{`${bytes} B after ${at} ms`}</title>
              </rect>
            );
          })}
        </svg>
      )}
    </div>
  );
}

export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
}

/** Server-sent events in a text/event-stream body (a partial last one included). */
export function parseSse(text: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const ev: SseEvent = { data: '' };
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const idx = line.indexOf(':');
      const field = idx < 0 ? line : line.slice(0, idx);
      const value = idx < 0 ? '' : line.slice(idx + 1).replace(/^ /, '');
      if (field === 'data') data.push(value);
      else if (field === 'event') ev.event = value;
      else if (field === 'id') ev.id = value;
    }
    if (data.length === 0 && ev.event === undefined) continue;
    ev.data = data.join('\n');
    out.push(ev);
  }
  return out;
}

/**
 * The text an LLM streamed, put back together from its deltas: Anthropic
 * (`delta.text`), OpenAI chat completions (`choices[].delta.content`) and the
 * OpenAI Responses API (`response.output_text.delta`). Empty for other streams.
 */
export function streamedText(events: SseEvent[]): string {
  let text = '';
  for (const ev of events) {
    let d: any;
    try {
      d = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (!d || typeof d !== 'object') continue;
    if (typeof d.delta?.text === 'string') text += d.delta.text;
    else if (typeof d.choices?.[0]?.delta?.content === 'string') text += d.choices[0].delta.content;
    else if (d.type === 'response.output_text.delta' && typeof d.delta === 'string') text += d.delta;
  }
  return text;
}

function oneLine(data: string): string {
  let s = data;
  try {
    s = JSON.stringify(JSON.parse(data));
  } catch {
    /* not JSON */
  }
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

/** A text/event-stream body as a list of events, with the raw text one click away. */
export function SseBody({ text }: { text: string }) {
  const [raw, setRaw] = useState(false);
  const events = parseSse(text);
  const assembled = streamedText(events);
  return (
    <>
      <div className="sse-switch">
        <button type="button" className={`iconbtn${raw ? '' : ' on'}`} onClick={() => setRaw(false)}>
          events ({events.length})
        </button>
        <button type="button" className={`iconbtn${raw ? ' on' : ''}`} onClick={() => setRaw(true)}>
          raw
        </button>
      </div>
      {raw ? (
        <pre>{text}</pre>
      ) : (
        <>
          {assembled && (
            <div className="sse-text">
              <div className="sec-head">
                <h3>streamed text</h3>
                <CopyButton text={assembled} />
              </div>
              <pre>{assembled}</pre>
            </div>
          )}
          <div className="sse-events">
            {events.map((ev, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: events never reorder
              <div key={i} className="sse-event">
                <span className="sse-name">{ev.event ?? 'message'}</span>
                <span className="sse-data" title={ev.data}>
                  {oneLine(ev.data)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
