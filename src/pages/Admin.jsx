import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Zap } from "lucide-react";
import QRCodeModal from "@/components/admin/QRCodeModal";
import GroupForm from "@/components/admin/GroupForm";
import GroupCard from "@/components/admin/GroupCard";
import GameControls from "@/components/admin/GameControls";

export default function Admin() {
  const [showForm, setShowForm] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const queryClient = useQueryClient();

  const { data: groups = [] } = useQuery({
    queryKey: ["groups"],
    queryFn: () => base44.entities.Group.list("order"),
  });

  const { data: sessions = [] } = useQuery({
    queryKey: ["session"],
    queryFn: () => base44.entities.GameSession.filter({ is_active: true }),
  });

  const { data: groupSessions = [] } = useQuery({
    queryKey: ["groupSessions"],
    queryFn: () => base44.entities.GroupSession.list(),
    refetchInterval: 5000,
  });

  const session = sessions[0];

  // Subscribe to session changes
  useEffect(() => {
    const unsub = base44.entities.GameSession.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ["session"] });
    });
    return unsub;
  }, [queryClient]);

  const ensureSession = async () => {
    if (session) return session;
    const newSession = await base44.entities.GameSession.create({
      status: "idle",
      question_number: 0,
      is_active: true,
    });
    queryClient.invalidateQueries({ queryKey: ["session"] });
    return newSession;
  };

  const handleNewQuestion = async () => {
    const s = await ensureSession();
    await base44.entities.GameSession.update(s.id, {
      status: "open",
      buzzed_group_id: "",
      buzzed_group_name: "",
      buzzed_group_color: "",
      buzzed_at: "",
      question_number: (s.question_number || 0) + 1,
    });
    queryClient.invalidateQueries({ queryKey: ["session"] });
  };

  const handleReset = async () => {
    const s = await ensureSession();
    await base44.entities.GameSession.update(s.id, {
      status: "idle",
      buzzed_group_id: "",
      buzzed_group_name: "",
      buzzed_group_color: "",
      buzzed_at: "",
      question_number: 0,
    });
    queryClient.invalidateQueries({ queryKey: ["session"] });
  };

  const handleSaveGroup = async (data) => {
    if (editingGroup) {
      await base44.entities.Group.update(editingGroup.id, data);
    } else {
      await base44.entities.Group.create({ ...data, order: groups.length });
    }
    queryClient.invalidateQueries({ queryKey: ["groups"] });
    setShowForm(false);
    setEditingGroup(null);
  };

  const handleDeleteGroup = async (group) => {
    await base44.entities.Group.delete(group.id);
    queryClient.invalidateQueries({ queryKey: ["groups"] });
  };

  const handleEdit = (group) => {
    setEditingGroup(group);
    setShowForm(true);
  };

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
          <Button onClick={() => { setEditingGroup(null); setShowForm(true); }} className="gap-2 font-bold">
            <Plus className="w-4 h-4" />
            קבוצה חדשה
          </Button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8 space-y-8">
        <GameControls
          session={session}
          onNewQuestion={handleNewQuestion}
          onReset={handleReset}
          groupCount={groups.length}
        />

        <div>
          <h2 className="text-lg font-bold mb-4">קבוצות ({groups.length})</h2>
          {groups.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Zap className="w-12 h-12 mx-auto mb-4 opacity-30" />
              <p className="text-lg font-medium">אין קבוצות עדיין</p>
              <p className="text-sm mt-1">הוסף קבוצות כדי להתחיל את המשחק</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {groups.map((group) => (
                <GroupCard
                  key={group.id}
                  group={group}
                  onEdit={handleEdit}
                  onDelete={handleDeleteGroup}
                  groupSessions={groupSessions}
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
            onSave={handleSaveGroup}
            onCancel={() => { setShowForm(false); setEditingGroup(null); }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}