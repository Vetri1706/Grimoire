import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';

export type ThemePreference = 'system' | 'dark' | 'light';
type ThemeControl = { theme: ThemePreference; changeTheme: (theme: ThemePreference) => void };
const themeKey = 'grimoire.theme-preference';
const parseTheme = (value: string | null | undefined): ThemePreference => value === 'light' || value === 'dark' ? value : 'system';
const ThemeContext = createContext<ThemeControl | null>(null);

// Keep the preference independent of its resolved color scheme. The bootstrap in
// index.html applies the same resolution before React (and the first paint).
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemePreference>(() => parseTheme(document.documentElement.dataset.themePreference));
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.dataset.themePreference = theme;
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      const background = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
      if (background) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
    };
    apply();
    if (theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === themeKey || event.key === null) setTheme(parseTheme(event.newValue));
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const changeTheme = useCallback((value: ThemePreference) => {
    setTheme(value);
    try { localStorage.setItem(themeKey, value); } catch { /* Appearance still works without browser storage. */ }
  }, []);
  return <ThemeContext.Provider value={{ theme, changeTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('Appearance controls require ThemeProvider.');
  return theme;
}

export function ThemePicker() {
  const { theme, changeTheme } = useTheme();
  return <label className="theme-picker">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {theme === 'system' ? <><rect x="3" y="3" width="18" height="13" rx="2" /><path d="M12 16v5M8 21h8" /></>
        : theme === 'dark' ? <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />
          : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" /></>}
    </svg>
    <select aria-label="Appearance" value={theme} onChange={event => changeTheme(parseTheme(event.target.value))}>
      <option value="system">System</option><option value="light">Pearl</option><option value="dark">Midnight Blue</option>
    </select>
  </label>;
}
