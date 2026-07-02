import { useEffect, useRef, useState } from 'react';

export type ExportKind = 'json' | 'har';

const ITEMS: { kind: ExportKind; label: string }[] = [
  { kind: 'json', label: 'JSON — raw' },
  { kind: 'har', label: 'HAR 1.2' },
];

/**
 * Header export split button: plain click keeps the historical behavior
 * (raw JSON download), the caret opens the format menu (JSON / HAR).
 */
export function ExportMenu({ onExport }: { onExport: (kind: ExportKind) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

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

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const run = async (kind: ExportKind) => {
    await onExport(kind);
    setOpen(false);
    setFlash(true);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), 1200);
  };

  return (
    <span className="copymenu" ref={rootRef}>
      <button
        className={`copymenu-main ${flash ? 'flash' : ''}`}
        title="download all captured requests as JSON"
        onClick={() => run('json')}
      >
        export
      </button>
      <button
        className="copymenu-caret"
        title="export format options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ▾
      </button>
      {open && (
        <div className="copymenu-pop right" role="menu">
          {ITEMS.map((item) => (
            <button key={item.kind} role="menuitem" onClick={() => run(item.kind)}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
