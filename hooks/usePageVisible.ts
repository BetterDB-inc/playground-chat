"use client";

import { useEffect, useState } from "react";

/**
 * Track document visibility. Lets pollers stop fetching when the tab is in
 * the background - important here because /api/stats hits Valkey on every
 * call and a backgrounded tab still polling is just waste.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(typeof document === "undefined" ? true : !document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
