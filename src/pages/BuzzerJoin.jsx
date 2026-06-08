// src/pages/BuzzerJoin.jsx
//
// Team picker shown at /play when a tablet has not yet been bound to a team
// (DESIGN.md §6, §13). Normally each tablet is pinned during provisioning and
// loads /play/:teamId directly; this picker is the operator fallback for the
// first load. Rewired off Base44 onto the shared store.
//
// It connects in the lightweight `display` role purely to receive the
// authoritative team list (`state.teams`, ordered by slot) — a display
// connection is cosmetic and harmless (DESIGN.md §14). Picking a team pins it to
// localStorage and navigates to /play/<id>, where BuzzerPlay re-pins it and opens
// the real tablet connection.

import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Zap, Loader2 } from "lucide-react";

import { initGame, useTeams, useConnection } from "@/store";
import { ROLE } from "../../shared/constants.js";

// Must match the key BuzzerPlay reads.
const LS_TEAM_ID = "buzzer.teamId";
const LS_CLIENT_ID = "buzzer.clientId";

/** Stable per-device client id (shared with BuzzerPlay). */
function getClientId() {
  try {
    let id = window.localStorage.getItem(LS_CLIENT_ID);
    if (!id) {
      id =
        window.crypto && typeof window.crypto.randomUUID === "function"
          ? window.crypto.randomUUID()
          : `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem(LS_CLIENT_ID, id);
    }
    return id;
  } catch {
    return `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

export default function BuzzerJoin() {
  const navigate = useNavigate();
  const clientId = useMemo(() => getClientId(), []);
  const [selecting, setSelecting] = useState(null);

  // Connect as a display just to receive the team list.
  useEffect(() => {
    const dispose = initGame({ role: ROLE.DISPLAY, clientId });
    return dispose;
  }, [clientId]);

  const teams = useTeams(); // already ordered by slot
  const { connection } = useConnection();

  const handleSelect = (team) => {
    if (selecting) return;
    setSelecting(team.id);
    try {
      window.localStorage.setItem(LS_TEAM_ID, team.id);
    } catch {
      /* ignore (private mode) */
    }
    // Navigate to the bound buzzer; BuzzerPlay opens the tablet connection.
    navigate(`/play/${team.id}`);
  };

  // Loading: socket not open yet, or open but no teams received.
  if (connection !== "open" && teams.length === 0) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-900 gap-4">
        <Loader2 className="w-8 h-8 animate-spin text-white" />
        <div className="text-white/40 text-sm" dir="rtl">
          מתחבר…
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center p-6"
      dir="rtl"
    >
      {/* Background blobs */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {teams.map((g, i) => (
          <div
            key={g.id}
            className="absolute w-72 h-72 rounded-full opacity-10 blur-3xl"
            style={{
              backgroundColor: g.color,
              top: `${20 + ((i * 30) % 60)}%`,
              left: `${10 + ((i * 25) % 80)}%`,
              transform: "translate(-50%, -50%)",
            }}
          />
        ))}
      </div>

      <div className="relative z-10 w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/20 flex items-center justify-center">
            <Zap className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-3xl font-black text-white">בחרו קבוצה</h1>
          <p className="text-white/40 mt-2">לחצו על הקבוצה שלכם</p>
        </div>

        {/* Team list */}
        {teams.length === 0 ? (
          <p className="text-center text-white/40">אין קבוצות עדיין</p>
        ) : (
          <div className="flex flex-col gap-3">
            {teams.map((team, i) => (
              <motion.button
                key={team.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.06 }}
                onClick={() => handleSelect(team)}
                disabled={!!selecting}
                className="w-full flex items-center gap-4 p-4 rounded-2xl text-white font-bold text-lg transition-all active:scale-95 disabled:opacity-60"
                style={{
                  backgroundColor: team.color + "33",
                  border: `2px solid ${team.color}`,
                }}
              >
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center font-black text-lg shrink-0"
                  style={{ backgroundColor: team.color }}
                >
                  {selecting === team.id ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    team.name?.[0]?.toUpperCase()
                  )}
                </div>
                <span>{team.name}</span>
              </motion.button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
