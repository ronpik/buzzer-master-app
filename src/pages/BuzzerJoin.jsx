import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Zap, Loader2 } from "lucide-react";

export default function BuzzerJoin() {
  const [selecting, setSelecting] = useState(null);

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ["groups"],
    queryFn: () => base44.entities.Group.list("order"),
  });

  const handleSelect = async (group) => {
    if (selecting) return;
    setSelecting(group.id);
    window.location.href = `/play/${group.id}`;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-900">
        <Loader2 className="w-8 h-8 animate-spin text-white" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center p-6" dir="rtl">
      {/* Background blobs */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {groups.map((g, i) => (
          <div
            key={g.id}
            className="absolute w-72 h-72 rounded-full opacity-10 blur-3xl"
            style={{
              backgroundColor: g.color,
              top: `${20 + (i * 30) % 60}%`,
              left: `${10 + (i * 25) % 80}%`,
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

        {/* Group list */}
        <div className="flex flex-col gap-3">
          {groups.map((group, i) => (
            <motion.button
              key={group.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06 }}
              onClick={() => handleSelect(group)}
              disabled={!!selecting}
              className="w-full flex items-center gap-4 p-4 rounded-2xl text-white font-bold text-lg transition-all active:scale-95 disabled:opacity-60"
              style={{
                backgroundColor: group.color + "33",
                border: `2px solid ${group.color}`,
              }}
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center font-black text-lg shrink-0"
                style={{ backgroundColor: group.color }}
              >
                {selecting === group.id ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  group.name?.[0]?.toUpperCase()
                )}
              </div>
              <span>{group.name}</span>
            </motion.button>
          ))}
        </div>
      </div>
    </div>
  );
}