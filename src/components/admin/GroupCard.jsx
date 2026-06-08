import React, { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Pencil, Trash2, Link as LinkIcon, QrCode, Check } from "lucide-react";
import QRCodeModal from "@/components/admin/QRCodeModal";

// One team card on the Admin grid (DESIGN.md §13). Presence is now driven purely
// by the live WebSocket: `connected` is the array of currently-connected tablet
// teamIds from the store (presence = the socket, DESIGN.md §8) — no heartbeat
// table, no `last_seen`, no stale rows.

export default function GroupCard({ group, onEdit, onDelete, connected = [] }) {
  const [copied, setCopied] = useState(false);
  const [showQR, setShowQR] = useState(false);

  const isConnected = connected.includes(group.id);

  // Tablet URL: pin the team via ?team=<id> on the buzzer page (DESIGN.md §6).
  const groupUrl = `${window.location.origin}/play?team=${group.id}`;

  const handleCopy = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(groupUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <Card className="overflow-hidden hover:shadow-lg transition-all duration-300">
        {group.banner_url ? (
          <div className="h-28 overflow-hidden">
            <img src={group.banner_url} alt={group.name} className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className="h-28" style={{ backgroundColor: group.color + "22" }}>
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-5xl font-black opacity-20" style={{ color: group.color }}>
                {group.name?.[0]?.toUpperCase()}
              </span>
            </div>
          </div>
        )}
        <div className="p-4" dir="rtl">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-5 h-5 rounded-full shrink-0 shadow-sm" style={{ backgroundColor: group.color }} />
            <h3 className="font-bold text-lg truncate flex-1">{group.name}</h3>
            {/* Connection indicator */}
            <div className="flex items-center gap-1.5">
              <div className={`w-2.5 h-2.5 rounded-full ${isConnected ? "bg-green-500" : "bg-gray-300"}`} />
              <span className={`text-xs font-medium ${isConnected ? "text-green-600" : "text-muted-foreground"}`}>
                {isConnected ? "מחובר" : "לא מחובר"}
              </span>
            </div>
          </div>

          {/* Slot badge */}
          {group.slot != null && (
            <div className="mb-3">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground bg-muted px-2.5 py-1 rounded-full">
                עמדה {group.slot}
              </span>
            </div>
          )}

          {/* Link + QR row */}
          <div className="flex gap-2 mb-3">
            <Button variant="outline" size="sm" className="flex-1 gap-1.5 text-xs h-8" onClick={handleCopy}>
              {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <LinkIcon className="w-3.5 h-3.5" />}
              {copied ? "הועתק!" : "העתק לינק"}
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5 text-xs h-8" onClick={() => setShowQR(true)}>
              <QrCode className="w-3.5 h-3.5" />
              QR
            </Button>
          </div>

          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onEdit(group)}>
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => onDelete(group)}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </Card>

      <QRCodeModal
        open={showQR}
        onOpenChange={setShowQR}
        url={groupUrl}
        title={group.name}
        groupColor={group.color}
      />
    </>
  );
}
