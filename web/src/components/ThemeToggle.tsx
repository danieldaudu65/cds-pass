import { setThemeMode, useThemeMode, type ThemeMode } from '../lib/theme';

const options: { id: ThemeMode; label: string; icon: string }[] = [
  { id: 'system', label: 'Auto', icon: 'M12 3a9 9 0 1 0 0 18V3z' },
  { id: 'light', label: 'Light', icon: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4' },
  { id: 'dark', label: 'Dark', icon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z' },
];

/** Auto (follows the phone), Light, Dark. */
export function ThemeToggle() {
  const mode = useThemeMode();
  return (
    <div className="space-y-2">
      <p className="font-bold">Appearance</p>
      <p className="text-sm text-muted">Auto follows your phone's light or dark setting.</p>
      <div className="grid grid-cols-3 gap-1.5 rounded-2xl bg-line p-1.5" role="radiogroup" aria-label="Appearance">
        {options.map((o) => (
          <button
            key={o.id}
            role="radio"
            aria-checked={mode === o.id}
            onClick={() => setThemeMode(o.id)}
            className={`flex h-12 items-center justify-center gap-2 rounded-xl text-sm font-bold transition-colors ${
              mode === o.id ? 'bg-card text-green shadow-card' : 'text-muted'
            }`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={o.icon} />
            </svg>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
