import { useMemo } from 'react';
import type { CapturedRequest } from '../types';
import { parseDurationMs, type StatusClass } from '../lib';

// Status chips carry a color class so an active chip reads like the table.
const STATUS_ITEMS: { value: StatusClass; cls: string }[] = [
  { value: '2xx', cls: 's2' },
  { value: '3xx', cls: 's3' },
  { value: '4xx', cls: 's4' },
  { value: '5xx', cls: 's5' },
  { value: 'error', cls: 'err' },
  { value: 'pending', cls: '' },
];

const BASE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SOURCES = ['fetch', 'http', 'replay'];

function Chip({
  label,
  on,
  cls,
  onToggle,
}: {
  label: string;
  on: boolean;
  cls?: string;
  onToggle: () => void;
}) {
  return (
    <button
      className={`chip${on ? ` on${cls ? ` ${cls}` : ''}` : ''}`}
      aria-pressed={on}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}

function DurationInput({
  value,
  bad,
  placeholder,
  title,
  onChange,
}: {
  value: string;
  bad: boolean;
  placeholder: string;
  title: string;
  onChange: (v: string) => void;
}) {
  const set = value.trim() !== '';
  return (
    <input
      type="text"
      inputMode="decimal"
      className={bad ? 'invalid' : set ? 'set' : ''}
      placeholder={placeholder}
      title={title}
      aria-label={title}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

interface Props {
  requests: CapturedRequest[];
  methods: ReadonlySet<string>;
  statuses: ReadonlySet<StatusClass>;
  sources: ReadonlySet<string>;
  durMin: string;
  durMax: string;
  onToggleMethod: (m: string) => void;
  onToggleStatus: (s: StatusClass) => void;
  onToggleSource: (s: string) => void;
  onDurMin: (v: string) => void;
  onDurMax: (v: string) => void;
  onClear: () => void;
}

export function FilterBar({
  requests,
  methods,
  statuses,
  sources,
  durMin,
  durMax,
  onToggleMethod,
  onToggleStatus,
  onToggleSource,
  onDurMin,
  onDurMax,
  onClear,
}: Props) {
  // Common verbs always; unusual ones (HEAD, OPTIONS, …) only once captured.
  // An active unusual chip stays visible after "clear" so it can be untoggled.
  const methodChips = useMemo(() => {
    const extra = new Set<string>();
    for (const r of requests) {
      const m = r.method.toUpperCase();
      if (!BASE_METHODS.includes(m)) extra.add(m);
    }
    for (const m of methods) if (!BASE_METHODS.includes(m)) extra.add(m);
    return [...BASE_METHODS, ...[...extra].sort()];
  }, [requests, methods]);

  // Unparseable text, or min above max, is flagged and ignored by the filter.
  const minMs = parseDurationMs(durMin);
  const maxMs = parseDurationMs(durMax);
  const inverted = minMs != null && maxMs != null && minMs > maxMs;
  const minBad = (durMin.trim() !== '' && minMs == null) || inverted;
  const maxBad = (durMax.trim() !== '' && maxMs == null) || inverted;

  const anyActive = methods.size + statuses.size + sources.size > 0 || !!durMin.trim() || !!durMax.trim();

  return (
    <div id="filterbar">
      {methodChips.map((m) => (
        <Chip key={m} label={m} cls={m} on={methods.has(m)} onToggle={() => onToggleMethod(m)} />
      ))}
      <span className="chip-sep" />
      {STATUS_ITEMS.map(({ value, cls }) => (
        <Chip key={value} label={value} cls={cls} on={statuses.has(value)} onToggle={() => onToggleStatus(value)} />
      ))}
      <span className="chip-sep" />
      {SOURCES.map((s) => (
        <Chip key={s} label={s} on={sources.has(s)} onToggle={() => onToggleSource(s)} />
      ))}
      <span className="chip-sep" />
      <span className="dur">
        time
        <DurationInput
          value={durMin}
          bad={minBad}
          placeholder="min"
          title="at least this long, e.g. 500, 500ms, 1.5s"
          onChange={onDurMin}
        />
        –
        <DurationInput
          value={durMax}
          bad={maxBad}
          placeholder="max"
          title="at most this long, e.g. 500, 500ms, 1.5s"
          onChange={onDurMax}
        />
      </span>
      {anyActive && (
        <button className="chip reset" onClick={onClear}>
          ✕ reset
        </button>
      )}
    </div>
  );
}
