import { ICON_MOON, ICON_SUN } from "./icons";

/**
 * Light/dark theme. The choice is stored in localStorage; the default is
 * dark, and the system preference only applies when nothing is saved.
 * The pre-paint script in public/index.html mirrors this resolution so the
 * first paint already has the right theme.
 */
export const THEME_STORAGE_KEY = "giwapad.theme";

export type Theme = "light" | "dark";

export function readSavedTheme(): Theme | null {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage unavailable (private mode, etc.) — non-fatal.
  }
  return null;
}

export function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Non-fatal; the theme still applies for this page load.
  }
  const button = document.querySelector<HTMLButtonElement>("#theme-toggle");
  if (button) {
    button.innerHTML = theme === "dark" ? ICON_SUN : ICON_MOON;
    button.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  }
}

export function initTheme(): void {
  const param = new URLSearchParams(location.search).get("theme");
  if (param === "light" || param === "dark") {
    applyTheme(param);
    return;
  }
  const saved = readSavedTheme();
  if (saved) {
    applyTheme(saved);
    return;
  }
  applyTheme(window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}

export function toggleTheme(): void {
  applyTheme(currentTheme() === "light" ? "dark" : "light");
}
