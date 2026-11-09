import { useSyncExternalStore } from 'react';

/** System = follow the phone/laptop setting. */
export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'cdspass:theme';
const subs = new Set<() => void>();
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function apply(mode: ThemeMode) {
  const dark = mode === 'dark' || (mode === 'system' && !!media?.matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#03301A' : '#0B6B3A');
}

export function setThemeMode(mode: ThemeMode) {
  try {
    if (mode === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
  apply(mode);
  subs.forEach((s) => s());
}

export function initTheme() {
  apply(getThemeMode());
  // When the phone switches to dark mode (e.g. at night), follow it.
  media?.addEventListener('change', () => {
    if (getThemeMode() === 'system') apply('system');
  });
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    getThemeMode,
  );
}
