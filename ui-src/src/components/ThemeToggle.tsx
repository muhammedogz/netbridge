import { Contrast, Moon, Sun } from 'lucide-react';
import { useTheme, type ThemePref } from '../useTheme';

const ICONS: Record<ThemePref, typeof Sun> = { light: Sun, dark: Moon, system: Contrast };

/** Cycles light → dark → system. The icon shows the current preference. */
export function ThemeToggle() {
  const { pref, cycle } = useTheme();
  const Icon = ICONS[pref];
  return (
    <button className="theme" onClick={cycle} title={`theme: ${pref}`} aria-label={`theme: ${pref}`}>
      <Icon />
    </button>
  );
}
