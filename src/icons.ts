/**
 * Inline SVG icons used by the JS-rendered controls (theme toggle, copy
 * button, explorer link). Static header icons (logo, nav tabs) live in
 * public/index.html. Stroke icons, 24x24 viewBox, inherit currentColor.
 */
const svg = (inner: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

/** Sun — shown on the theme toggle while the dark theme is active. */
export const ICON_SUN = svg(
  `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>`,
);

/** Moon — shown on the theme toggle while the light theme is active. */
export const ICON_MOON = svg(`<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`);

/** Two overlapping rectangles — the copy-address button. */
export const ICON_COPY = svg(
  `<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`,
);

/** Arrow out of a box — the "view on explorer" link. */
export const ICON_EXTERNAL_LINK = svg(
  `<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>`,
);
