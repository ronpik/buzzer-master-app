// src/pages/BuzzerPlay.jsx
//
// Tablet buzzer page (DESIGN.md §13 "Tablet — buzzer (/play)"). Rewired off the
// Base44 data layer onto the local Node authority via the shared store.
//
// Key behaviours from the design:
//   - teamId is pinned per device (localStorage), so a kiosk reload re-binds the
//     same team. The team can be set the first time via the URL (/play/:teamId or
//     ?team=<id>) during provisioning (DESIGN.md §6, §13).
//   - The press is timestamped at the EDGE in the synchronous pointer handler
//     using the event's high-res timeStamp (same origin as performance.now()),
//     then handed straight to the store — NO React state in the buzz critical
//     path (DESIGN.md §11).
//   - Buzzing is gated on a completed clock sync; the button shows "syncing…" and
//     is disabled until connected + synced (DESIGN.md §10).
//   - A Screen Wake Lock is requested at runtime as a belt-and-suspenders against
//     sleep / Wi-Fi power-save (DESIGN.md §6, §13).
//   - Optimistic "pressed" UI; the real outcome arrives via buzzResult/rejected.
//     On disconnect the optimistic flag is cleared by the store, so the button is
//     never left stuck (fixes the old "pressing stuck true" bug, DESIGN.md §14).

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, Loader2, WifiOff } from "lucide-react";

import {
  initGame,
  buzz,
  useTeams,
  useStatus,
  useCanBuzz,
  useMyResult,
  useBuzzSent,
  useConnection,
  useLastReject,
} from "@/store";
import { ROLE, STATUS, REJECT_REASON, UI_COLOR } from "../../shared/constants.js";

// localStorage keys (this page owns device identity persistence).
const LS_TEAM_ID = "buzzer.teamId";
const LS_CLIENT_ID = "buzzer.clientId";

/** Resolve the team this tablet is bound to: URL param / ?team=, else pinned
 *  localStorage value. Persists whatever it resolves so the binding survives a
 *  kiosk reload (DESIGN.md §6). */
function resolveTeamId(routeId) {
  let id = routeId;
  if (!id) {
    const q = new URLSearchParams(window.location.search).get("team");
    if (q) id = q;
  }
  if (!id) {
    try {
      id = window.localStorage.getItem(LS_TEAM_ID) || null;
    } catch {
      id = null;
    }
  }
  if (id) {
    try {
      window.localStorage.setItem(LS_TEAM_ID, id);
    } catch {
      /* ignore (private mode) */
    }
  }
  return id;
}

/** Stable per-device client id, generated once and pinned (DESIGN.md §8). */
function getClientId() {
  try {
    let id = window.localStorage.getItem(LS_CLIENT_ID);
    if (!id) {
      id =
        (window.crypto && typeof window.crypto.randomUUID === "function"
          ? window.crypto.randomUUID()
          : `c_${Date.now()}_${Math.random().toString(36).slice(2)}`);
      window.localStorage.setItem(LS_CLIENT_ID, id);
    }
    return id;
  } catch {
    // Private mode / storage disabled: a per-load id is fine (single socket).
    return `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

/** Request the Screen Wake Lock; re-acquire on visibility regain. Returns a
 *  cleanup that releases it. Best-effort: unsupported browsers no-op. */
function useWakeLock(active) {
  useEffect(() => {
    if (!active) return undefined;
    if (!("wakeLock" in navigator)) return undefined;

    let sentinel = null;
    let released = false;

    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request("screen");
        sentinel.addEventListener?.("release", () => {
          sentinel = null;
        });
      } catch {
        /* user gesture may be required; the page is a kiosk so this is fine */
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !sentinel && !released) {
        acquire();
      }
    };

    acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibility);
      try {
        sentinel?.release();
      } catch {
        /* ignore */
      }
      sentinel = null;
    };
  }, [active]);
}

export default function BuzzerPlay() {
  const { groupId } = useParams();
  // Resolve identity once for the lifetime of the page.
  const teamId = useMemo(() => resolveTeamId(groupId), [groupId]);
  const clientId = useMemo(() => getClientId(), []);

  // Connect this tablet to the authority. Disposer closes the socket on unmount.
  useEffect(() => {
    if (!teamId) return undefined;
    const dispose = initGame({ role: ROLE.TABLET, clientId, teamId });
    return dispose;
  }, [teamId, clientId]);

  useWakeLock(!!teamId);

  // --- server-fed state ----------------------------------------------------
  const teams = useTeams();
  const status = useStatus();
  const canBuzz = useCanBuzz();
  const myResult = useMyResult(); // 'won' | 'lost' | null
  const buzzSent = useBuzzSent();
  const { connection, synced } = useConnection();
  const lastReject = useLastReject();

  const team = useMemo(
    () => teams.find((t) => t.id === teamId) || null,
    [teams, teamId],
  );

  // --- buzz: edge timestamp in the synchronous handler (DESIGN.md §11) ------
  // No React state is read/written before sending; we capture the press time as
  // the very first thing and hand it straight to the store.
  const lastPressTsRef = useRef(0);
  const handlePress = useCallback((e) => {
    // High-res edge time; fall back to perf-now if a browser lacks event timing.
    const edgeTs =
      typeof e?.timeStamp === "number" && e.timeStamp > 0
        ? e.timeStamp
        : performance.now();
    // De-dupe a pointerdown+touchstart pair for the same physical press.
    if (edgeTs - lastPressTsRef.current < 50) return;
    lastPressTsRef.current = edgeTs;
    // The store enforces synced/open/not-already-pressed; this is fire-and-forget.
    buzz(edgeTs);
  }, []);

  // --- false-start: brief local lockout flash (DESIGN.md §11, §14) ---------
  const [falseStart, setFalseStart] = useState(false);
  const lastRejectRoundRef = useRef(null);
  useEffect(() => {
    if (!lastReject) return undefined;
    // Only react to a given rejection once.
    const key = `${lastReject.roundId}:${lastReject.reason}`;
    if (lastRejectRoundRef.current === key) return undefined;
    lastRejectRoundRef.current = key;
    if (lastReject.reason === REJECT_REASON.FALSE_START) {
      setFalseStart(true);
      const id = setTimeout(() => setFalseStart(false), 1200);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [lastReject]);

  // Clear the false-start flash whenever a new round opens.
  useEffect(() => {
    if (status === STATUS.OPEN) setFalseStart(false);
  }, [status]);

  // --- no team bound -------------------------------------------------------
  if (!teamId) {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-neutral-900 text-white text-xl px-6 text-center"
        dir="rtl"
      >
        לא נבחרה קבוצה למכשיר זה
      </div>
    );
  }

  // Team list not yet received from the server (initial connect).
  if (!team) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-900 gap-4">
        <Loader2 className="w-8 h-8 animate-spin text-white" />
        <div className="text-white/40 text-sm" dir="rtl">
          {connection === "open" ? "טוען קבוצה…" : "מתחבר…"}
        </div>
      </div>
    );
  }

  // --- derive view ----------------------------------------------------------
  const isOpen = status === STATUS.OPEN || status === STATUS.SETTLING;
  const connecting = connection !== "open";
  const syncing = connection === "open" && !synced;
  // Active = the button is live AND we haven't optimistically pressed yet.
  const isActive = canBuzz && !falseStart;
  // Pressed-and-waiting: we sent a buzz, round still open, no result yet.
  const pressedPending = buzzSent && isOpen && !myResult;

  let bgColor = UI_COLOR.IDLE_BG;
  if (myResult === "won") bgColor = UI_COLOR.WIN;
  else if (myResult === "lost") bgColor = UI_COLOR.LOSE;

  let buttonLabel = "ממתינים...";
  if (falseStart) buttonLabel = "מוקדם מדי!";
  else if (isActive) buttonLabel = "לחץ!";
  else if (pressedPending) buttonLabel = "נשלח!";
  else if (myResult === "won") buttonLabel = "🎉 ראשונים!";
  else if (myResult === "lost") buttonLabel = "איחרת";

  // The motion key drives the enter/exit animation between visual states.
  const visualKey = falseStart
    ? "falsestart"
    : myResult
      ? myResult
      : pressedPending
        ? "pending"
        : isActive
          ? "active"
          : "waiting";

  return (
    <div
      className="min-h-screen flex flex-col select-none overflow-hidden relative"
      style={{ backgroundColor: bgColor }}
    >
      {/* Color bar at top */}
      <div className="w-full h-3 shrink-0" style={{ backgroundColor: team.color }} />

      {/* Team image — identity anchor for this tablet. `object-contain` scales it
          to fit without cropping; capped height keeps the buzzer the focus. */}
      {team.banner_url && (
        <div className="shrink-0 flex justify-center px-6 mt-12 mb-1">
          <img
            src={team.banner_url}
            alt={team.name}
            className="max-h-[15vh] max-w-[70%] object-contain rounded-xl"
          />
        </div>
      )}

      {/* Connection / sync indicator (top-right) */}
      <div className="absolute top-5 right-4 z-20 flex items-center gap-2 text-xs font-medium" dir="rtl">
        {connecting ? (
          <span className="flex items-center gap-1.5 text-white/70 bg-black/30 px-3 py-1.5 rounded-full">
            <WifiOff className="w-3.5 h-3.5" />
            מתחבר…
          </span>
        ) : syncing ? (
          <span className="flex items-center gap-1.5 text-white/70 bg-black/30 px-3 py-1.5 rounded-full">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            מסנכרן…
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-white/60 bg-black/20 px-3 py-1.5 rounded-full">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#22C55E" }} />
            מחובר
          </span>
        )}
      </div>

      {/* Buzzer button area */}
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          handlePress(e);
        }}
        disabled={!isActive}
        className="flex-1 flex flex-col items-center justify-center w-full cursor-pointer disabled:cursor-default transition-all duration-200 active:scale-95"
        style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={visualKey}
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.8, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="flex flex-col items-center"
          >
            {/* Active — pulsing with team color glow */}
            {isActive && (
              <motion.div
                animate={{
                  scale: [1, 1.07, 1],
                  boxShadow: [
                    `0 0 40px ${team.color}55`,
                    `0 0 100px ${team.color}cc`,
                    `0 0 40px ${team.color}55`,
                  ],
                }}
                transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
                className="w-48 h-48 md:w-64 md:h-64 rounded-full flex items-center justify-center mb-8"
                style={{ backgroundColor: team.color }}
              >
                <div className="text-center">
                  <Zap className="w-12 h-12 mx-auto mb-2 text-white" />
                  <div className="text-white font-black text-3xl md:text-4xl">לחץ!</div>
                </div>
              </motion.div>
            )}

            {/* Pressed and waiting for the result (optimistic) */}
            {!isActive && pressedPending && (
              <div
                className="w-48 h-48 md:w-64 md:h-64 rounded-full flex items-center justify-center mb-8"
                style={{ backgroundColor: team.color, opacity: 0.85 }}
              >
                <div className="text-center">
                  <Loader2 className="w-10 h-10 mx-auto mb-2 text-white animate-spin" />
                  <div className="text-white font-black text-2xl md:text-3xl">נשלח!</div>
                </div>
              </div>
            )}

            {/* False start — brief lockout flash */}
            {!isActive && falseStart && (
              <div
                className="w-48 h-48 md:w-64 md:h-64 rounded-full flex items-center justify-center mb-8"
                style={{ backgroundColor: "#7c2d12" }}
              >
                <div className="text-white font-black text-2xl md:text-3xl text-center px-4">
                  מוקדם מדי!
                </div>
              </div>
            )}

            {/* Idle / waiting — greyed out, clearly disabled */}
            {!isActive && !pressedPending && !falseStart && !myResult && (
              <div
                className="w-48 h-48 md:w-64 md:h-64 rounded-full flex items-center justify-center mb-8"
                style={{ backgroundColor: "#2a2a2a", boxShadow: "none" }}
              >
                <div className="text-center">
                  <Zap className="w-12 h-12 mx-auto mb-2 text-white/15" />
                  <div className="text-white/25 font-bold text-xl">
                    {syncing ? "מסנכרן…" : connecting ? "מתחבר…" : "ממתינים..."}
                  </div>
                </div>
              </div>
            )}

            {/* Won / Lost states */}
            {(myResult === "won" || myResult === "lost") && (
              <div
                className="w-48 h-48 md:w-64 md:h-64 rounded-full flex items-center justify-center mb-8"
                style={{ backgroundColor: "rgba(255,255,255,0.25)" }}
              >
                <div className="text-white font-black text-3xl md:text-4xl text-center">
                  {buttonLabel}
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </button>

      {/* Team name footer */}
      <div className="shrink-0 pb-8 pt-4 text-center">
        <div
          className="inline-block px-8 py-4 rounded-2xl"
          style={{
            backgroundColor: isActive
              ? team.color
              : myResult === "won" || myResult === "lost"
                ? "rgba(255,255,255,0.2)"
                : "#2a2a2a",
          }}
        >
          <span
            className="font-black text-2xl md:text-3xl tracking-wide"
            style={{
              color:
                isActive || myResult || pressedPending
                  ? "white"
                  : "rgba(255,255,255,0.3)",
            }}
          >
            {team.name}
          </span>
        </div>
      </div>
    </div>
  );
}
