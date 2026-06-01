import React, { useState, useEffect, useCallback, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, Loader2 } from "lucide-react";

const HEARTBEAT_INTERVAL = 10000; // 10s

export default function BuzzerPlay() {
  const urlParams = new URLSearchParams(window.location.search);
  const pathParts = window.location.pathname.split("/");
  const groupId = pathParts[pathParts.length - 1];

  const [buzzerState, setBuzzerState] = useState("waiting"); // waiting, won, lost
  const [pressing, setPressing] = useState(false);
  const queryClient = useQueryClient();
  const prevStatusRef = useRef(null);
  const groupSessionIdRef = useRef(null);

  const { data: group, isLoading: groupLoading } = useQuery({
    queryKey: ["group", groupId],
    queryFn: async () => {
      const groups = await base44.entities.Group.filter({ id: groupId });
      return groups[0];
    },
    enabled: !!groupId,
  });

  const { data: sessions = [] } = useQuery({
    queryKey: ["session"],
    queryFn: () => base44.entities.GameSession.filter({ is_active: true }),
  });

  const session = sessions[0];

  // Subscribe to real-time session changes
  useEffect(() => {
    const unsub = base44.entities.GameSession.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ["session"] });
    });
    return unsub;
  }, [queryClient]);

  // Register presence + heartbeat
  useEffect(() => {
    if (!group) return;

    let intervalId;

    const register = async () => {
      // Check if already registered for this group
      const existing = await base44.entities.GroupSession.filter({ group_id: group.id });
      let sessionId;
      if (existing.length > 0) {
        await base44.entities.GroupSession.update(existing[0].id, { last_seen: new Date().toISOString() });
        sessionId = existing[0].id;
      } else {
        const created = await base44.entities.GroupSession.create({
          group_id: group.id,
          group_name: group.name,
          group_color: group.color,
          last_seen: new Date().toISOString(),
        });
        sessionId = created.id;
      }
      groupSessionIdRef.current = sessionId;

      intervalId = setInterval(async () => {
        await base44.entities.GroupSession.update(sessionId, { last_seen: new Date().toISOString() });
      }, HEARTBEAT_INTERVAL);
    };

    register();

    return () => {
      clearInterval(intervalId);
      // Don't delete immediately — grace period handled by Display
    };
  }, [group?.id]);

  // Update buzzer state based on session
  useEffect(() => {
    if (!session || !group) return;

    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = session.status;

    if (session.status === "open") {
      setBuzzerState("waiting");
      setPressing(false);
    } else if (session.status === "buzzed") {
      if (session.buzzed_group_id === group.id) {
        setBuzzerState("won");
      } else {
        setBuzzerState("lost");
      }
    } else if (session.status === "idle") {
      setBuzzerState("waiting");
      setPressing(false);
    }
  }, [session?.status, session?.buzzed_group_id, session?.question_number, group?.id]);

  const handleBuzz = useCallback(async () => {
    if (!session || session.status !== "open" || pressing) return;
    setPressing(true);

    await base44.entities.GameSession.update(session.id, {
      status: "buzzed",
      buzzed_group_id: group.id,
      buzzed_group_name: group.name,
      buzzed_group_color: group.color,
      buzzed_at: new Date().toISOString(),
    });
  }, [session, group, pressing]);

  if (groupLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-900">
        <Loader2 className="w-8 h-8 animate-spin text-white" />
      </div>
    );
  }

  if (!group) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-900 text-white text-xl" dir="rtl">
        קבוצה לא נמצאה
      </div>
    );
  }

  const isOpen = session?.status === "open";
  const isIdle = !session || session.status === "idle";

  const isActive = isOpen && buzzerState === "waiting";

  let bgColor = "#1a1a1a";
  if (buzzerState === "won") bgColor = "#22C55E";
  else if (buzzerState === "lost") bgColor = "#EF4444";

  let buttonLabel = "ממתינים...";
  if (isActive) buttonLabel = "לחץ!";
  else if (buzzerState === "won") buttonLabel = "🎉 ראשונים!";
  else if (buzzerState === "lost") buttonLabel = "איחרת";

  return (
    <div className="min-h-screen flex flex-col select-none overflow-hidden relative" style={{ backgroundColor: bgColor }}>
      {/* Color bar at top */}
      <div className="w-full h-3 shrink-0" style={{ backgroundColor: group.color }} />

      {/* Buzzer button area */}
      <button
        onTouchStart={(e) => { e.preventDefault(); handleBuzz(); }}
        onClick={handleBuzz}
        disabled={!isActive}
        className="flex-1 flex flex-col items-center justify-center w-full cursor-pointer disabled:cursor-default transition-all duration-200 active:scale-95"
        style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={buzzerState + (session?.status || "")}
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.8, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="flex flex-col items-center"
          >
            {/* Idle/waiting — greyed out, clearly disabled */}
            {!isActive && buzzerState === "waiting" && (
              <div
                className="w-48 h-48 md:w-64 md:h-64 rounded-full flex items-center justify-center mb-8"
                style={{ backgroundColor: "#2a2a2a", boxShadow: "none" }}
              >
                <div className="text-center">
                  <Zap className="w-12 h-12 mx-auto mb-2 text-white/15" />
                  <div className="text-white/25 font-bold text-xl">ממתינים...</div>
                </div>
              </div>
            )}

            {/* Active — pulsing with group color glow */}
            {isActive && (
              <motion.div
                animate={{ scale: [1, 1.07, 1], boxShadow: [
                  `0 0 40px ${group.color}55`,
                  `0 0 100px ${group.color}cc`,
                  `0 0 40px ${group.color}55`,
                ]}}
                transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
                className="w-48 h-48 md:w-64 md:h-64 rounded-full flex items-center justify-center mb-8"
                style={{ backgroundColor: group.color }}
              >
                <div className="text-center">
                  <Zap className="w-12 h-12 mx-auto mb-2 text-white" />
                  <div className="text-white font-black text-3xl md:text-4xl">לחץ!</div>
                </div>
              </motion.div>
            )}

            {/* Won / Lost states */}
            {(buzzerState === "won" || buzzerState === "lost") && (
              <div
                className="w-48 h-48 md:w-64 md:h-64 rounded-full flex items-center justify-center mb-8"
                style={{ backgroundColor: "rgba(255,255,255,0.25)" }}
              >
                <div className="text-white font-black text-3xl md:text-4xl text-center">{buttonLabel}</div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </button>

      {/* Group name footer */}
      <div className="shrink-0 pb-8 pt-4 text-center">
        <div
          className="inline-block px-8 py-4 rounded-2xl"
          style={{ backgroundColor: isActive ? group.color : (buzzerState === "won" || buzzerState === "lost" ? "rgba(255,255,255,0.2)" : "#2a2a2a") }}
        >
          <span className="font-black text-2xl md:text-3xl tracking-wide" style={{ color: isActive || buzzerState !== "waiting" ? "white" : "rgba(255,255,255,0.3)" }}>
            {group.name}
          </span>
        </div>
      </div>
    </div>
  );
}