import React, { createContext, useContext, useEffect, useState } from 'react';
import { getSetting, setSetting } from '../db/db';

export type ThemeMode = 'dark' | 'light';

export interface ThemeColors {
  mode: ThemeMode;
  bg: string;
  card: string;
  cardBorder: string;
  border: string;
  text: string;
  sub: string;
  accent: string;
  danger: string;
  barBg: string;
  status: string;
  thumbBg: string;
  headerBg: string;
}

export const darkTheme: ThemeColors = {
  mode: 'dark',
  bg: '#08080a',
  card: '#141619',
  cardBorder: '#22252a',
  border: '#22252a',
  text: '#e7e9ea',
  sub: '#8b9299',
  accent: '#1d9bf0',
  danger: '#f4212e',
  barBg: '#08080a',
  status: '#1d9bf0',
  thumbBg: '#22252a',
  headerBg: '#08080a',
};

export const lightTheme: ThemeColors = {
  mode: 'light',
  bg: '#f4f6f8',
  card: '#ffffff',
  cardBorder: '#e2e8f0',
  border: '#e2e8f0',
  text: '#0f1419',
  sub: '#536471',
  accent: '#1d9bf0',
  danger: '#f4212e',
  barBg: '#ffffff',
  status: '#1d9bf0',
  thumbBg: '#edf2f7',
  headerBg: '#f4f6f8',
};

interface ThemeContextValue {
  theme: ThemeMode;
  isDark: boolean;
  colors: ThemeColors;
  toggleTheme: () => void;
  setTheme: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  isDark: true,
  colors: darkTheme,
  toggleTheme: () => {},
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>('dark');

  useEffect(() => {
    (async () => {
      try {
        const saved = await getSetting('theme', 'dark');
        if (saved === 'light' || saved === 'dark') {
          setThemeState(saved);
        }
      } catch {
        // Default to dark if DB is not ready
      }
    })();
  }, []);

  const setTheme = (mode: ThemeMode) => {
    setThemeState(mode);
    setSetting('theme', mode).catch(() => {});
  };

  const toggleTheme = () => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  const colors = theme === 'dark' ? darkTheme : lightTheme;

  return (
    <ThemeContext.Provider
      value={{
        theme,
        isDark: theme === 'dark',
        colors,
        toggleTheme,
        setTheme,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
