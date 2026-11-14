"use client";

import { useEffect, useState } from "react";

/** The theme actually in effect (explicit choice first, then the system setting). Re-renders when it changes. */
export function useResolvedTheme(): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const read = () => {
      const t = document.documentElement.dataset.theme;
      setTheme(t === "light" || t === "dark" ? t : mq.matches ? "light" : "dark");
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    mq.addEventListener("change", read);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", read);
    };
  }, []);
  return theme;
}
