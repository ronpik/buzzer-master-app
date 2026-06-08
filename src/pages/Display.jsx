import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, HelpCircle, Trophy, Volume2, WifiOff } from "lucide-react";
import { ROLE, STATUS } from "../../shared/constants.js";
import {
  initGame,
  useStatus,
  useTeams,
  useConnected,
  useWinner,
  useConnection,
} from "@/store";

// ---------------------------------------------------------------------------
// Display page (DESIGN.md §13).
//
// Big-screen view for the hall, rendered on the host and sent over HDMI to the
// projector. It is a pure *reader* of the server-owned game store: it never
// mutates state, it just renders idle / open / buzzed from whatever the latest
// server `state` / `buzzResult` says, and plays the buzzer sound when a winner
// is declared. The Base44 + React-Query + heartbeat data layer is gone; this is
// fed by one WebSocket via the shared store (../store.js).
// ---------------------------------------------------------------------------

async function playBuzzerSound(existingCtx) {
  const ctx = existingCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
  const playTone = (freq, startTime, duration, type = "sawtooth", gain = 0.3) => {
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);
    gainNode.gain.setValueAtTime(gain, startTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.start(startTime);
    osc.stop(startTime + duration);
  };
  const now = ctx.currentTime;
  playTone(440, now, 0.15, "sawtooth", 0.4);
  playTone(330, now + 0.12, 0.15, "sawtooth", 0.4);
  playTone(220, now + 0.24, 0.3, "sawtooth", 0.5);
}

/**
 * Stable per-device id for this display, persisted so reconnects re-`hello`
 * with the same identity (DESIGN.md §8/§13). Generated once on first load.
 */
function getDisplayClientId() {
  const KEY = "buzzer.display.clientId";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `display-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // localStorage unavailable (private mode): a per-session id is fine here.
    return `display-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export default function Display() {
  const prevStatusRef = useRef(null);
  const audioCtxRef = useRef(null);
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  // --- server-owned state (single source of truth) ------------------------
  const status = useStatus();
  const teams = useTeams();
  const connected = useConnected();
  const winner = useWinner();
  const { connection } = useConnection();

  // Connect this page to the server as the DISPLAY role for the page lifetime.
  useEffect(() => {
    const dispose = initGame({
      role: ROLE.DISPLAY,
      clientId: getDisplayClientId(),
    });
    return dispose;
  }, []);

  const unlockAudio = async () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtxRef.current.state === "suspended") {
      await audioCtxRef.current.resume();
    }
    setAudioUnlocked(true);
  };

  // Connected tablets, by teamId, for the connection dots.
  const connectedTeamIds = new Set(connected);

  // Play the buzzer sound on the transition into a decided round (BUZZED).
  useEffect(() => {
    if (status === STATUS.BUZZED && prevStatusRef.current !== STATUS.BUZZED) {
      playBuzzerSound(audioCtxRef.current);
    }
    prevStatusRef.current = status;
  }, [status]);

  // `settling` is an internal server state (≤ settling window); the display
  // keeps showing the "open" visuals during it (DESIGN.md §12).
  const isIdle = status === STATUS.IDLE;
  const isOpen = status === STATUS.OPEN || status === STATUS.SETTLING;
  const isBuzzed = status === STATUS.BUZZED;

  // The winning team's full record (for its banner; `winner` carries name/color
  // but not the banner_url, which lives on the team).
  const winnerTeam = winner ? teams.find((t) => t.id === winner.teamId) : null;
  const winnerColor = winner?.color || winnerTeam?.color || "#22C55E";
  const winnerName = winner?.name || winnerTeam?.name || "";
  const winnerBanner = winnerTeam?.banner_url;

  return (
    <div className="h-screen bg-neutral-950 flex flex-col overflow-hidden">
      {/* Background blobs */}
      <div className="absolute inset-0 pointer-events-none">
        {teams.map((t, i) => (
          <div
            key={t.id}
            className="absolute w-96 h-96 rounded-full opacity-10 blur-3xl"
            style={{
              backgroundColor: t.color,
              top: `${20 + (i * 30) % 60}%`,
              left: `${10 + (i * 25) % 80}%`,
              transform: "translate(-50%, -50%)",
            }}
          />
        ))}
      </div>

      {/* Connection lost indicator — cosmetic; the display reconnects and
          re-renders from `state` automatically (DESIGN.md §14). */}
      {connection !== "open" && (
        <div className="absolute top-4 left-4 z-30 flex items-center gap-2 bg-red-500/15 text-red-300 text-sm px-3 py-2 rounded-full">
          <WifiOff className="w-4 h-4" />
          <span dir="rtl">מתחבר מחדש…</span>
        </div>
      )}

      {/* Audio unlock */}
      {!audioUnlocked && (
        <button
          onClick={unlockAudio}
          className="absolute top-4 right-4 z-30 flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white text-sm px-3 py-2 rounded-full transition-all"
        >
          <Volume2 className="w-4 h-4" />
          הפעל שמע
        </button>
      )}

      {/* TOP: Conference logo — fixed height */}
      <div className="relative z-10 shrink-0 flex justify-center" style={{ height: "42vh" }}>
        <img
          src="https://media.base44.com/images/public/6a06440b9cc120c4d65bec24/0bf06b89c_73CardioLogoheb.png"
          alt="Conference Logo"
          className="h-full object-contain"
        />
      </div>

      {/* MIDDLE: Game content — fills remaining space */}
      <div className="relative z-10 flex-1 flex items-center justify-center w-full px-6 overflow-hidden">
        <div className="w-full max-w-2xl">
          <AnimatePresence mode="wait">

            {/* IDLE */}
            {isIdle && (
              <motion.div
                key="idle"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="text-center"
              >
                <div className="w-24 h-24 mx-auto mb-6 rounded-full bg-white/5 flex items-center justify-center">
                  <Zap className="w-12 h-12 text-white/20" />
                </div>
                <p className="text-white/40 text-2xl font-bold" dir="rtl">ממתינים להתחלת המשחק</p>
                <p className="text-white/20 text-lg mt-2" dir="rtl">{connectedTeamIds.size} / {teams.length} קבוצות מחוברות</p>
                {teams.length > 0 && (
                  <div className="flex flex-wrap justify-center gap-4 mt-8">
                    {teams.map((t) => {
                      const isConnected = connectedTeamIds.has(t.id);
                      return (
                        <div key={t.id} className="flex flex-col items-center gap-2">
                          <div className="relative">
                            <div
                              className="w-14 h-14 rounded-2xl flex items-center justify-center text-white font-black text-lg shadow-lg transition-opacity"
                              style={{ backgroundColor: t.color, opacity: isConnected ? 1 : 0.3 }}
                            >
                              {t.name?.[0]?.toUpperCase()}
                            </div>
                            {/* Connection dot */}
                            <div
                              className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-neutral-950"
                              style={{ backgroundColor: isConnected ? "#22C55E" : "#6b7280" }}
                            />
                          </div>
                          <span className={`text-xs font-medium ${isConnected ? "text-white/70" : "text-white/20"}`}>{t.name}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </motion.div>
            )}

            {/* OPEN */}
            {isOpen && (
              <motion.div
                key="open"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="text-center"
              >
                <motion.div
                  animate={{ scale: [1, 1.1, 1] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                  className="w-36 h-36 mx-auto mb-6 rounded-full bg-amber-500/20 flex items-center justify-center"
                  style={{ boxShadow: "0 0 80px rgba(245, 158, 11, 0.3)" }}
                >
                  <HelpCircle className="w-18 h-18 text-amber-400" style={{ width: 72, height: 72 }} />
                </motion.div>
                <p className="text-amber-400 text-4xl font-black" dir="rtl">מי יודע?</p>
                <p className="text-white/30 text-lg mt-3" dir="rtl">לחצו על הבאזר!</p>
                <div className="flex flex-wrap justify-center gap-3 mt-8">
                  {teams.map((t) => {
                    const isConnected = connectedTeamIds.has(t.id);
                    return (
                      <motion.div
                        key={t.id}
                        animate={isConnected ? { opacity: [0.5, 1, 0.5] } : {}}
                        transition={{ duration: 2, repeat: Infinity, delay: Math.random() }}
                        className="px-4 py-2 rounded-full text-white font-bold text-sm flex items-center gap-2"
                        style={{ backgroundColor: "#000000", border: `2px solid ${isConnected ? t.color : "#374151"}`, opacity: isConnected ? 1 : 0.3 }}
                      >
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: isConnected ? "#22C55E" : "#6b7280" }} />
                        {t.name}
                      </motion.div>
                    );
                  })}
                </div>
              </motion.div>
            )}

            {/* BUZZED */}
            {isBuzzed && winner && (
              <motion.div
                key="buzzed"
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.5 }}
                transition={{ type: "spring", stiffness: 200, damping: 15 }}
                className="text-center"
              >
                <motion.div
                  initial={{ rotate: -10 }}
                  animate={{ rotate: [0, 5, -5, 0] }}
                  transition={{ duration: 0.5, delay: 0.3 }}
                >
                  <Trophy className="w-16 h-16 mx-auto mb-4 text-amber-400" />
                </motion.div>

                <motion.div
                  initial={{ y: 30, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.2 }}
                >
                  {winnerBanner ? (
                    <div
                      className="w-full max-w-sm mx-auto mb-4 rounded-2xl overflow-hidden shadow-2xl"
                      style={{ aspectRatio: "16/9", border: `6px solid ${winnerColor}` }}
                    >
                      <img
                        src={winnerBanner}
                        alt={winnerName}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  ) : (
                    <motion.div
                      animate={{ scale: [1, 1.02, 1] }}
                      transition={{ duration: 2, repeat: Infinity }}
                      className="inline-block px-12 py-6 rounded-3xl text-white mb-4"
                      style={{
                        backgroundColor: winnerColor,
                        boxShadow: `0 0 100px ${winnerColor}66`
                      }}
                    >
                      <p className="text-5xl md:text-7xl font-black">{winnerName}</p>
                    </motion.div>
                  )}
                </motion.div>

                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.5 }}
                  className="text-white/40 text-xl font-bold"
                  dir="rtl"
                >
                  ענו ראשונים! 🎯
                </motion.p>
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </div>

      {/* BOTTOM: Powered by Ortra — fixed height */}
      <div className="relative z-10 shrink-0 bg-black/60 backdrop-blur-sm flex items-center justify-center gap-2" style={{ height: "10vh" }}>
        <span className="text-white/50 text-base font-medium">This event is powered by</span>
        <img
          src="https://media.base44.com/images/public/6a06440b9cc120c4d65bec24/1024255a7_ORTRALOGOWHite3.png"
          alt="Ortra"
          className="h-14 object-contain"
          style={{ marginTop: "6px" }}
        />
      </div>
    </div>
  );
}
