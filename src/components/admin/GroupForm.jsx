import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X } from "lucide-react";
import { PRESET_COLORS, MIN_SLOT, MAX_SLOT } from "../../../shared/constants.js";

// Team create/edit form (DESIGN.md §13). Local-only: it builds the `Team` shape
// ({ id?, name, color, banner_url, slot }) and hands it to `onSave`, which the
// Admin page forwards to the store's `upsertTeam` over the WebSocket. There is no
// Base44 upload anymore — a banner is just an (optional) image URL or local asset
// path the operator pastes in (DESIGN.md §21, open question #2).

export default function GroupForm({ group, onSave, onCancel, takenSlots = [] }) {
  // Pick the lowest free slot for a new team; keep the existing slot when editing.
  const firstFreeSlot = () => {
    for (let s = MIN_SLOT; s <= MAX_SLOT; s++) {
      if (!takenSlots.includes(s)) return s;
    }
    return MIN_SLOT;
  };

  const [name, setName] = useState(group?.name || "");
  const [color, setColor] = useState(group?.color || PRESET_COLORS[0]);
  const [bannerUrl, setBannerUrl] = useState(group?.banner_url || "");
  const [slot, setSlot] = useState(group?.slot ?? firstFreeSlot());

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({
      ...(group?.id ? { id: group.id } : {}),
      name: name.trim(),
      color,
      banner_url: bannerUrl.trim() || null,
      slot: Number(slot),
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="name" className="text-sm font-semibold">שם הקבוצה</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="הכנס שם קבוצה..."
          className="text-lg h-12"
          dir="rtl"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-semibold">עמדה (טאבלט)</Label>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: MAX_SLOT - MIN_SLOT + 1 }, (_, i) => MIN_SLOT + i).map((s) => {
            // A slot taken by *another* team is disabled; the current team's own slot stays selectable.
            const takenByOther = takenSlots.includes(s) && s !== group?.slot;
            const selected = Number(slot) === s;
            return (
              <button
                key={s}
                type="button"
                disabled={takenByOther}
                onClick={() => setSlot(s)}
                className="w-12 h-12 rounded-xl font-black text-lg transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:scale-110"
                style={{
                  backgroundColor: selected ? color : "hsl(var(--muted))",
                  color: selected ? "white" : "hsl(var(--muted-foreground))",
                  border: selected ? "3px solid hsl(var(--foreground))" : "3px solid transparent",
                }}
              >
                {s}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">כל קבוצה משויכת לעמדה אחת (1–{MAX_SLOT}), בהתאם לטאבלט שלה.</p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-semibold">צבע הקבוצה</Label>
        <div className="flex flex-wrap gap-2">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-110"
              style={{
                backgroundColor: c,
                border: color === c ? "3px solid hsl(var(--foreground))" : "3px solid transparent",
                boxShadow: color === c ? `0 0 0 2px hsl(var(--background)), 0 4px 12px ${c}66` : "none"
              }}
            />
          ))}
        </div>
        <div className="flex items-center gap-2 mt-2">
          <Label className="text-xs text-muted-foreground">או בחר צבע מותאם:</Label>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="w-8 h-8 rounded cursor-pointer border-0"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="banner" className="text-sm font-semibold">באנר הקבוצה (לא חובה)</Label>
        {bannerUrl ? (
          <div className="relative rounded-xl overflow-hidden border" style={{ aspectRatio: "16/9" }}>
            <img
              src={bannerUrl}
              alt="Banner"
              className="w-full h-full object-cover"
              onError={(e) => { e.currentTarget.style.opacity = "0.2"; }}
            />
            <button
              type="button"
              onClick={() => setBannerUrl("")}
              className="absolute top-2 right-2 bg-black/60 text-white rounded-full p-1 hover:bg-black/80"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <Input
            id="banner"
            value={bannerUrl}
            onChange={(e) => setBannerUrl(e.target.value)}
            placeholder="כתובת תמונה (URL)..."
            className="h-11"
            dir="ltr"
          />
        )}
      </div>

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={!name.trim()} className="flex-1 h-11 text-base font-bold">
          {group ? "עדכן" : "הוסף קבוצה"}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} className="h-11">
            ביטול
          </Button>
        )}
      </div>
    </form>
  );
}
