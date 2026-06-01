import React, { useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, HelpCircle, Trophy, Volume2 } from "lucide-react";

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

const GRACE_PERIOD_MS = 30000; // 30s

export default function Display() {
  const queryClient = useQueryClient();
  const prevStatusRef = useRef(null);
  const audioCtxRef = useRef(null);
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  const unlockAudio = async () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtxRef.current.state === "suspended") {
      await audioCtxRef.current.resume();
    }
    setAudioUnlocked(true);
  };

  const { data: sessions = [] } = useQuery({
    queryKey: ["session"],
    queryFn: () => base44.entities.GameSession.filter({ is_active: true }),
  });

  const { data: groups = [] } = useQuery({
    queryKey: ["groups"],
    queryFn: () => base44.entities.Group.list("order"),
  });

  const { data: groupSessions = [] } = useQuery({
    queryKey: ["groupSessions"],
    queryFn: () => base44.entities.GroupSession.list(),
    refetchInterval: 5000,
  });

  // Connected = last_seen within grace period
  const connectedGroupIds = new Set(
    groupSessions
      .filter(gs => gs.last_seen && (Date.now() - new Date(gs.last_seen).getTime()) < GRACE_PERIOD_MS)
      .map(gs => gs.group_id)
  );

  const session = sessions[0];

  useEffect(() => {
    const unsub = base44.entities.GameSession.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ["session"] });
    });
    return unsub;
  }, [queryClient]);

  useEffect(() => {
    const unsub = base44.entities.Group.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ["groups"] });
    });
    return unsub;
  }, [queryClient]);

  useEffect(() => {
    const unsub = base44.entities.GroupSession.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ["groupSessions"] });
    });
    return unsub;
  }, [queryClient]);

  useEffect(() => {
    if (session?.status === "buzzed" && prevStatusRef.current !== "buzzed") {
      playBuzzerSound(audioCtxRef.current);
    }
    prevStatusRef.current = session?.status;
  }, [session?.status, session?.buzzed_group_id]);

  const isIdle = !session || session.status === "idle";
  const isOpen = session?.status === "open";
  const isBuzzed = session?.status === "buzzed";

  return (
    <div className="h-screen bg-neutral-950 flex flex-col overflow-hidden">
      {/* Background blobs */}
      <div className="absolute inset-0 pointer-events-none">
        {groups.map((g, i) => (
          <div
            key={g.id}
            className="absolute w-96 h-96 rounded-full opacity-10 blur-3xl"
            style={{
              backgroundColor: g.color,
              top: `${20 + (i * 30) % 60}%`,
              left: `${10 + (i * 25) % 80}%`,
              transform: "translate(-50%, -50%)",
            }}
          />
        ))}
      </div>

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
                <p className="text-white/20 text-lg mt-2" dir="rtl">{connectedGroupIds.size} / {groups.length} קבוצות מחוברות</p>
                {groups.length > 0 && (
                  <div className="flex flex-wrap justify-center gap-4 mt-8">
                    {groups.map((g) => {
                      const isConnected = connectedGroupIds.has(g.id);
                      return (
                        <div key={g.id} className="flex flex-col items-center gap-2">
                          <div className="relative">
                            <div
                              className="w-14 h-14 rounded-2xl flex items-center justify-center text-white font-black text-lg shadow-lg transition-opacity"
                              style={{ backgroundColor: g.color, opacity: isConnected ? 1 : 0.3 }}
                            >
                              {g.name?.[0]?.toUpperCase()}
                            </div>
                            {/* Connection dot */}
                            <div
                              className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-neutral-950"
                              style={{ backgroundColor: isConnected ? "#22C55E" : "#6b7280" }}
                            />
                          </div>
                          <span className={`text-xs font-medium ${isConnected ? "text-white/70" : "text-white/20"}`}>{g.name}</span>
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
                  {groups.map((g) => {
                    const isConnected = connectedGroupIds.has(g.id);
                    return (
                      <motion.div
                        key={g.id}
                        animate={isConnected ? { opacity: [0.5, 1, 0.5] } : {}}
                        transition={{ duration: 2, repeat: Infinity, delay: Math.random() }}
                        className="px-4 py-2 rounded-full text-white font-bold text-sm flex items-center gap-2"
                        style={{ backgroundColor: "#000000", border: `2px solid ${isConnected ? g.color : "#374151"}`, opacity: isConnected ? 1 : 0.3 }}
                      >
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: isConnected ? "#22C55E" : "#6b7280" }} />
                        {g.name}
                      </motion.div>
                    );
                  })}
                </div>
              </motion.div>
            )}

            {/* BUZZED */}
            {isBuzzed && (
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
                  {groups.find(g => g.id === session.buzzed_group_id)?.banner_url ? (
                    <div
                      className="w-full max-w-sm mx-auto mb-4 rounded-2xl overflow-hidden shadow-2xl"
                      style={{ aspectRatio: "16/9", border: `6px solid ${session.buzzed_group_color || "#22C55E"}` }}
                    >
                      <img
                        src={groups.find(g => g.id === session.buzzed_group_id)?.banner_url}
                        alt={session.buzzed_group_name}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  ) : (
                    <motion.div
                      animate={{ scale: [1, 1.02, 1] }}
                      transition={{ duration: 2, repeat: Infinity }}
                      className="inline-block px-12 py-6 rounded-3xl text-white mb-4"
                      style={{
                        backgroundColor: session.buzzed_group_color || "#22C55E",
                        boxShadow: `0 0 100px ${session.buzzed_group_color || "#22C55E"}66`
                      }}
                    >
                      <p className="text-5xl md:text-7xl font-black">{session.buzzed_group_name}</p>
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