import { brand } from "@tickdoctor/shared";

const c = brand.colors;

/**
 * All colours originate in packages/shared/src/brand.ts. The light theme is derived from the
 * same values with color-mix(), so changing the brand changes both themes.
 * Health colours: `--health-*` are fills/borders, `--health-*-text` are tuned for >= 4.5:1 text.
 */
export const darkVars = `
  --bg: var(--b-bg);
  --surface: var(--b-surface);
  --surface-2: color-mix(in srgb, var(--b-surface), white 6%);
  --fg: var(--b-text);
  --muted: var(--b-muted);
  --border: color-mix(in srgb, var(--b-muted) 28%, transparent);
  --input-border: color-mix(in srgb, var(--b-bg), var(--b-muted) 70%);
  --accent: var(--b-accent);
  --accent-fg: var(--b-bg);
  --accent-text: var(--b-accent);
  --grid-line: color-mix(in srgb, var(--b-accent) 9%, transparent);
  --ring: var(--b-accent);
  --health-healthy-text: color-mix(in srgb, var(--b-healthy), white 22%);
  --health-degraded-text: color-mix(in srgb, var(--b-degraded), white 15%);
  --health-lagging-text: color-mix(in srgb, var(--b-lagging), white 30%);
  --health-offline-text: color-mix(in srgb, var(--b-offline), white 40%);
  --health-waiting-text: color-mix(in srgb, var(--b-waiting), white 25%);
  color-scheme: dark;
`;

export const lightVars = `
  --bg: color-mix(in srgb, var(--b-text), white 65%);
  --surface: #ffffff;
  --surface-2: color-mix(in srgb, var(--b-text), white 40%);
  --fg: color-mix(in srgb, var(--b-bg), black 10%);
  --muted: color-mix(in srgb, var(--b-muted), black 48%);
  --border: color-mix(in srgb, var(--b-bg) 16%, transparent);
  --input-border: color-mix(in srgb, var(--b-muted), black 15%);
  --accent: var(--b-accent);
  --accent-fg: var(--b-bg);
  --accent-text: color-mix(in srgb, var(--b-accent), black 66%);
  --grid-line: color-mix(in srgb, var(--b-bg) 7%, transparent);
  --ring: color-mix(in srgb, var(--b-accent), black 60%);
  --health-healthy-text: color-mix(in srgb, var(--b-healthy), black 40%);
  --health-degraded-text: color-mix(in srgb, var(--b-degraded), black 52%);
  --health-lagging-text: color-mix(in srgb, var(--b-lagging), black 42%);
  --health-offline-text: color-mix(in srgb, var(--b-offline), black 45%);
  --health-waiting-text: color-mix(in srgb, var(--b-waiting), black 50%);
  color-scheme: light;
`;

export const themeCss = `
:root{
  --b-bg:${c.background};--b-surface:${c.surface};--b-text:${c.text};--b-muted:${c.muted};--b-accent:${c.accent};
  --b-healthy:${c.health.healthy};--b-degraded:${c.health.degraded};--b-lagging:${c.health.lagging};--b-offline:${c.health.offline};--b-waiting:${c.health.waiting};
  --health-healthy:var(--b-healthy);--health-degraded:var(--b-degraded);--health-lagging:var(--b-lagging);--health-offline:var(--b-offline);--health-waiting:var(--b-waiting);
  ${darkVars}
}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){${lightVars}}}
:root[data-theme="light"]{${lightVars}}
:root[data-theme="dark"]{${darkVars}}
`;

/** Runs before first paint: applies a saved explicit choice, otherwise CSS follows the system. */
export const themeInitScript = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
