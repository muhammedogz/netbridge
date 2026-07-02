import { useEffect, useRef, useState } from 'react';
import { copyText } from '../lib';

export function CopyButton({ text, label = 'copy' }: { text: string | (() => string); label?: string }) {
  const [flash, setFlash] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      className={`iconbtn ${flash ? 'flash' : ''}`}
      onClick={async () => {
        await copyText(typeof text === 'function' ? text() : text);
        setFlash(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setFlash(false), 1200);
      }}
    >
      {flash ? 'copied!' : label}
    </button>
  );
}
