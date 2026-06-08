import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Zap, Wifi, WifiOff } from "lucide-react";
import GroupForm from "@/components/admin/GroupForm";
import GroupCard from "@/components/admin/GroupCard";
import GameControls from "@/components/admin/GameControls";
import Diagnostics from "@/components/admin/Diagnostics";
import { ROLE } from "../../shared/constants.js";
import {
  initGame,
  useTeams,
  useConnected,
  useStatus,
  useQuestionNumber,
  useWinner,
  useRanking,
  useConnection,
  openQuestion,
  resetGame,
  clearBuzz,
  upsertTeam,
  deleteTeam,
} from "../store.js";

// Admin / host page (DESIGN.md §13, host-only). The entire data layer is the
// WS-fed game store: the server is the single source of truth, so this page only
// reads server state and emits intent (openQuestion / resetGame / clearBuzz /
// upsertTeam / deleteTeam). No Base44, no React-Query, no shared "session" row.

/** Stable per-device client id (DESIGN.md §8 `hello.clientId`). */
function getClientId() {
  const KEY = "buzzer.clientId";
  let id = null;
  try {
    id = localStorage.getItem(KEY);
    if (!id) {
      id =
        (window.crypto?.randomUUID?.() ??
          `c-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(KEY, id);
    }
  } catch {
    // Private mode / no storage: a per-session id is fine for the admin.
    id = `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return id;
}

export default function Admin() {
  const [showForm, setShowForm] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);

  // Server-authoritative state.
  const teams = useTeams();
  const connected = useConnected();
  const status = useStatus();
  const questionNumber = useQuestionNumber();
  const winner = useWinner();
  const ranking = useRanking();
  const connection = useConnection();

  // One WebSocket for the whole page; torn down on unmount.
  useEffect(() => initGame({ role: ROLE.ADMIN, clientId: getClientId() }), []);

  const handleNewQuestion = () => openQuestion();
  const handleReset = () => resetGame();
  const handleClearBuzz = () => clearBuzz();

  const handleSaveGroup = (data) => {
    // `upsertTeam` is fire-and-forget over the socket; a fresh `state` snapshot
    // (with the new/edited team) arrives from the server and re-renders the grid.
    upsertTeam(data);
    setShowForm(false);
    setEditingGroup(null);
  };

  const handleDeleteGroup = (group) => deleteTeam(group.id);

  const handleEdit = (group) => {
    setEditingGroup(group);
    setShowForm(true);
  };

  const isOnline = connection.connection === "open";
  const takenSlots = teams.map((t) => t.slot).filter((s) => s != null);

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
              <Zap className="w-5 h-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-black tracking-tight">BUZZER</h1>
              <p className="text-xs text-muted-foreground">ניהול משחק טריוויה</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Server connection indicator */}
            <div
              className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full ${
                isOnline ? "text-green-600 bg-green-100" : "text-red-600 bg-red-100"
              }`}
              title={isOnline ? "מחובר לשרת" : "מנותק מהשרת"}
            >
              {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              {isOnline ? "מחובר" : "מנותק"}
            </div>
            <Button onClick={() => { setEditingGroup(null); setShowForm(true); }} className="gap-2 font-bold">
              <Plus className="w-4 h-4" />
              קבוצה חדשה
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8 space-y-8">
        <GameControls
          status={status}
          questionNumber={questionNumber}
          winner={winner}
          groupCount={teams.length}
          onNewQuestion={handleNewQuestion}
          onReset={handleReset}
          onClearBuzz={handleClearBuzz}
        />

        <Diagnostics
          connection={connection}
          teams={teams}
          connected={connected}
          ranking={ranking}
        />

        <div>
          <h2 className="text-lg font-bold mb-4">קבוצות ({teams.length})</h2>
          {teams.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Zap className="w-12 h-12 mx-auto mb-4 opacity-30" />
              <p className="text-lg font-medium">אין קבוצות עדיין</p>
              <p className="text-sm mt-1">הוסף קבוצות כדי להתחיל את המשחק</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {teams.map((group) => (
                <GroupCard
                  key={group.id}
                  group={group}
                  onEdit={handleEdit}
                  onDelete={handleDeleteGroup}
                  connected={connected}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-right">
              {editingGroup ? "עריכת קבוצה" : "קבוצה חדשה"}
            </DialogTitle>
          </DialogHeader>
          <GroupForm
            group={editingGroup}
            takenSlots={takenSlots}
            onSave={handleSaveGroup}
            onCancel={() => { setShowForm(false); setEditingGroup(null); }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
