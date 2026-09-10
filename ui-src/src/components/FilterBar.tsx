import { useMemo } from 'react';
import type { CapturedRequest } from '../types';
import type { StatusClass } from '../filter';

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
const SOURCES = ['fetch', 'http'];

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

interface Props {
  requests: CapturedRequest[];
  methods: ReadonlySet<string>;
  statuses: ReadonlySet<StatusClass>;
  sources: ReadonlySet<string>;
  onToggleMethod: (m: string) => void;
  onToggleStatus: (s: StatusClass) => void;
  onToggleSource: (s: string) => void;
  onClear: () => void;
}

export function FilterBar({
  requests,
  methods,
  statuses,
  sources,
  onToggleMethod,
  onToggleStatus,
  onToggleSource,
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

  const anyActive = methods.size + statuses.size + sources.size > 0;

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
      {anyActive && (
        <button className="chip reset" onClick={onClear}>
          ✕ reset
        </button>
      )}
    </div>
  );
}
