// Single source of truth for product identity. Change the name here and everything follows.
// "TickDoctor" is a working name ("LagDoctor" already exists).
export const brand = {
  name: "TickDoctor",
  tagline: "Find out why your Minecraft server lags — in plain English.",
  domain: "tickdoctor.example", // TODO: real domain once chosen
  supportEmail: "hello@tickdoctor.example",
  colors: {
    // Dark-first palette. Health colours are chosen to stay distinguishable for
    // deuteranopia/protanopia (blue / amber / magenta, plus an icon + label every time).
    background: "#0e1116",
    surface: "#161b22",
    text: "#e6edf3",
    muted: "#8b949e",
    accent: "#5eead4", // teal "pixel" accent
    health: {
      healthy: "#3b82f6", // blue, icon: check
      degraded: "#f59e0b", // amber, icon: half-filled square
      lagging: "#d946ef", // magenta, icon: warning triangle
      offline: "#6b7280", // grey, icon: hollow square
      waiting: "#8a94a6", // lighter grey-blue, icon: clock (never sent data yet)
    },
  },
  legalDisclaimer:
    "Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.",
} as const;

export type HealthState = keyof typeof brand.colors.health;
