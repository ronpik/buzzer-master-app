import React, { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Play, RotateCcw, Monitor, QrCode, Eraser } from "lucide-react";
import QRCodeModal from "@/components/admin/QRCodeModal";
import { useToast } from "@/components/ui/use-toast";
import { STATUS } from "../../../shared/constants.js";

// Host game controls (DESIGN.md §13). Reads authoritative game state from the
// store (passed in as props by Admin) and emits intent — openQuestion / reset /
// clearBuzz — over the WebSocket. No local "session" row is mutated; the server
// is the single source of truth.

export default function GameControls({
  status,
  questionNumber,
  winner,
  groupCount,
  onNewQuestion,
  onReset,
  onClearBuzz,
}) {
  const [showQR, setShowQR] = useState(false);
  const { toast } = useToast();

  const displayUrl = `${window.location.origin}/display`;

  const copyDisplayLink = () => {
    navigator.clipboard.writeText(displayUrl);
    toast({
      title: "הקישור הועתק!",
      description: "פתח את הקישור במסך נוסף להקרנת התשובה",
    });
  };

  // `settling` is internal (≤ window ms); show it as "open" to the operator (§12).
  const isOpen = status === STATUS.OPEN || status === STATUS.SETTLING;
  const isBuzzed = status === STATUS.BUZZED;

  const statusBadge = isBuzzed
    ? { label: `${winner?.name || "קבוצה"} ענתה!`, color: "bg-green-100 text-green-800" }
    : isOpen
      ? { label: "ממתינים לתשובה...", color: "bg-amber-100 text-amber-800" }
      : { label: "ממתין להתחלה", color: "bg-muted text-muted-foreground" };

  return (
    <Card className="border-2" dir="rtl">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold">ניהול משחק</h2>
            <p className="text-sm text-muted-foreground mt-1">שאלה מספר {questionNumber || 0}</p>
          </div>
          <div className={`px-4 py-2 rounded-full text-sm font-bold ${statusBadge.color}`}>
            {statusBadge.label}
          </div>
        </div>

        {isBuzzed && winner?.name && (
          <div
            className="mb-6 p-4 rounded-2xl text-center text-white font-black text-2xl animate-pulse"
            style={{ backgroundColor: winner.color || "#22C55E" }}
          >
            🎯 {winner.name}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Button
            onClick={onNewQuestion}
            disabled={groupCount === 0}
            className="h-14 text-base font-bold gap-2 bg-primary hover:bg-primary/90"
            size="lg"
          >
            <Play className="w-5 h-5" />
            שאלה חדשה
          </Button>
          <Button
            onClick={onReset}
            variant="outline"
            className="h-14 text-base font-bold gap-2"
            size="lg"
          >
            <RotateCcw className="w-5 h-5" />
            איפוס משחק
          </Button>
        </div>

        {/* Optional retry: clear the current buzz and reopen the SAME question (§12). */}
        {isBuzzed && (
          <div className="mt-3">
            <Button
              onClick={onClearBuzz}
              variant="secondary"
              className="w-full h-11 gap-2 font-bold"
            >
              <Eraser className="w-4 h-4" />
              נקה תשובה ופתח מחדש
            </Button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 mt-3">
          <Button
            onClick={copyDisplayLink}
            variant="secondary"
            className="gap-2"
          >
            <Monitor className="w-4 h-4" />
            העתק קישור תצוגה
          </Button>
          <Button
            onClick={() => setShowQR(true)}
            variant="secondary"
            className="gap-2"
          >
            <QrCode className="w-4 h-4" />
            הצג QR
          </Button>
        </div>

        <QRCodeModal
          open={showQR}
          onOpenChange={setShowQR}
          url={displayUrl}
          title="מסך תצוגה מרכזי"
          groupColor="#22C55E"
        />
      </CardContent>
    </Card>
  );
}
