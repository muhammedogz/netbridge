import { Settings } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const VIEWS: { grouped: boolean; label: string; hint: string }[] = [
  { grouped: true, label: 'grouped by request', hint: 'calls under the page render or API route that made them' },
  { grouped: false, label: 'flat list', hint: 'every outbound call on its own row, in arrival order' },
];

/** Header settings: preferences kept in this browser. */
export function SettingsMenu({
  grouped,
  onGrouped,
  onAgent,
}: {
  grouped: boolean;
  onGrouped: (grouped: boolean) => void;
  /** Opens the "connect an AI agent" dialog (MCP server, HTTP API). */
  onAgent: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="copymenu" ref={rootRef}>
      <button
        type="button"
        className="theme"
        title="settings"
        aria-label="settings"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Settings />
      </button>
      {open && (
        <div className="copymenu-pop right settings-pop" role="menu">
          <div className="settings-head">request list</div>
          {VIEWS.map((v) => (
            <button
              type="button"
              key={v.label}
              role="menuitemradio"
              aria-checked={grouped === v.grouped}
              title={v.hint}
              onClick={() => {
                onGrouped(v.grouped);
                setOpen(false);
              }}
            >
              <span className="settings-check">{grouped === v.grouped ? '✓' : ''}</span>
              {v.label}
              <span className="settings-hint">{v.hint}</span>
            </button>
          ))}
          <div className="copymenu-div" />
          <div className="settings-head">AI agents</div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAgent();
            }}
          >
            <span className="settings-check" />
            connect an agent…
            <span className="settings-hint">MCP server setup and the HTTP API briefing</span>
          </button>
        </div>
      )}
    </span>
  );
}
