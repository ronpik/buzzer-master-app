// src/lib/fullscreen.js
//
// Best-effort Fullscreen API wrapper for the tablet kiosk flow. Browsers only
// grant fullscreen from inside a user-gesture handler (never automatically on
// page load), so callers invoke enterFullscreen() synchronously from a tap —
// the team pick on /play, or the on-screen "מסך מלא" button. Once entered, it
// survives SPA navigation (same document); a reload or Esc drops it, which is
// why the pages re-offer the button whenever isFullscreen() is false.
// Vendor-prefixed fallbacks cover older WebKit (iPad Safari).

import { useEffect, useState } from "react";

/** True while the document is currently in fullscreen mode. */
export function isFullscreen() {
  return Boolean(
    document.fullscreenElement || document.webkitFullscreenElement,
  );
}

/** True if this browser can enter fullscreen at all (iPhone Safari cannot). */
export function fullscreenSupported() {
  const el = document.documentElement;
  return Boolean(el.requestFullscreen || el.webkitRequestFullscreen);
}

/** Enter fullscreen on the whole page. Must be called from a user gesture. */
export function enterFullscreen() {
  if (isFullscreen()) return;
  const el = document.documentElement;
  try {
    if (el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    }
  } catch {
    /* unsupported or denied — the game runs fine windowed */
  }
}

/** Reactive isFullscreen(): re-renders the caller on fullscreen changes. */
export function useIsFullscreen() {
  const [fs, setFs] = useState(() => isFullscreen());
  useEffect(() => {
    const onChange = () => setFs(isFullscreen());
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);
  return fs;
}
