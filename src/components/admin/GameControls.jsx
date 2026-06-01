import React, { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Play, RotateCcw, Monitor, Zap, QrCode } from "lucide-react";
import QRCodeModal from "@/components/admin/QRCodeModal";
import { useToast } from "@/components/ui/use-toast";

export default function GameControls({ session, onNewQuestion, onReset, groupCount }) {
  const [showQR, setShowQR] = useState(false);
  const { toast } = useToast();

  const copyDisplayLink = () => {
    const url = `${window.location.origin}/display`;
    navigator.clipboard.writeText(url);
    toast({
      title: "הקישור הועתק!",
      description: "פתח את הקישור במסך נוסף להקרנת התשובה",
    });
  };

  const displayUrl = `${window.location.origin}/display`;

  const statusMap = {
    idle: { label: "ממתין להתחלה", color: "bg-muted text-muted-foreground" },
    open: { label: "ממתינים לתשובה...", color: "bg-amber-100 text-amber-800" },
    buzzed: { label: `${session?.buzzed_group_name || "קבוצה"} ענתה!`, color: "bg-green-100 text-green-800" }
  };

  const status = statusMap[session?.status || "idle"];

  return (
    <Card className="border-2" dir="rtl">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold">ניהול משחק</h2>
            <p className="text-sm text-muted-foreground mt-1">שאלה מספר {session?.question_number || 0}</p>
          </div>
          <div className={`px-4 py-2 rounded-full text-sm font-bold ${status.color}`}>
            {status.label}
          </div>
        </div>

        {session?.status === "buzzed" && session?.buzzed_group_name && (
          <div
            className="mb-6 p-4 rounded-2xl text-center text-white font-black text-2xl animate-pulse"
            style={{ backgroundColor: session.buzzed_group_color || "#22C55E" }}
          >
            🎯 {session.buzzed_group_name}
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