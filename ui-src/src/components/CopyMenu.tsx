import { useEffect, useRef, useState } from 'react';
import type { CapturedRequest } from '../types';
import { copyText, formatRequestJSON, formatRequestMarkdown } from '../lib';

interface MenuItem {
  label: string;
  build: (r: CapturedRequest) => string;
}

// The split button's primary action is the first item (Markdown essentials).
const ITEMS: MenuItem[] = [
  { label: 'Markdown — essentials', build: (r) => formatRequestMarkdown(r, false) },
  { label: 'Markdown — everything', build: (r) => formatRequestMarkdown(r, true) },
  { label: 'JSON — essentials', build: (r) => formatRequestJSON(r, false) },
  { label: 'JSON — everything', build: (r) => formatRequestJSON(r, true) },
];

export function CopyMenu({ r }: { r: CapturedRequest }) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>();

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

  const doCopy = async (item: MenuItem) => {
    await copyText(item.build(r));
    setOpen(false);
    setFlash(true);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), 1200);
  };

  return (
    <span className="copymenu" ref={rootRef}>
      <button
        className={`iconbtn copymenu-main ${flash ? 'flash' : ''}`}
        title="copy this request as Markdown (essentials)"
        onClick={() => doCopy(ITEMS[0])}
      >
        {flash ? 'copied!' : 'copy request'}
      </button>
      <button
        className="iconbtn copymenu-caret"
        title="copy format options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ▾
      </button>
      {open && (
        <div className="copymenu-pop" role="menu">
          {ITEMS.map((item) => (
            <button key={item.label} role="menuitem" onClick={() => doCopy(item)}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
