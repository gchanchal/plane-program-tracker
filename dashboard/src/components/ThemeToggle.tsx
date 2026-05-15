import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '@/lib/use-theme';

const ICONS = { light: Sun, dark: Moon, system: Monitor };
const LABELS = { light: 'Light', dark: 'Dark', system: 'System' };

export function ThemeToggle() {
  const { pref, cycle } = useTheme();
  const Icon = ICONS[pref];
  return (
    <button
      type="button"
      onClick={cycle}
      title={`Theme: ${LABELS[pref]} (click to change)`}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-foreground hover:bg-accent transition-colors"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
