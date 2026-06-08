import React, { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X, Upload, Loader2 } from "lucide-react";
import { PRESET_COLORS, MIN_SLOT, MAX_SLOT } from "../../../shared/constants.js";

// Team create/edit form (DESIGN.md §13). Local-only: it builds the `Team` shape
// ({ id?, name, color, banner_url, slot }) and hands it to `onSave`, which the
// Admin page forwards to the store's `upsertTeam` over the WebSocket.
//
// The team image is optional. The operator can upload a file — we downscale it in
// the browser and embed it as a compressed data URL — or paste an image URL.
// Embedding (rather than pointing at a remote URL) keeps the image self-contained:
// it rides the team `state` broadcast and renders on every device (admin / display
// / tablet) with no CDN or internet dependency, which is exactly what an offline
// LAN needs (DESIGN.md §21, open question #2).

// Largest dimension (px) we keep when embedding a team image. Big enough to look
// crisp in the display's winner banner, small enough that the resulting data URL
// rides comfortably inside the team-list `state` broadcast (server/game.js sends
// the whole team list on every round event).
const MAX_IMAGE_DIM = 600;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024; // refuse absurdly large source files

/**
 * Read an image File, scale it down so its longest side fits MAX_IMAGE_DIM
 * (preserving aspect ratio — never upscales), and return a compressed data URL.
 * WebP keeps logo transparency and compresses photos well; browsers without WebP
 * encoding fall back to lossless PNG automatically.
 * @param {File} file
 * @param {number} [maxDim]
 * @returns {Promise<string>}
 */
function fileToScaledDataUrl(file, maxDim = MAX_IMAGE_DIM) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type?.startsWith("image/")) {
      reject(new Error("not an image"));
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      reject(new Error("file too large"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        const longest = Math.max(img.width, img.height) || 1;
        const scale = Math.min(1, maxDim / longest);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);
        let out = canvas.toDataURL("image/webp", 0.82);
        if (!out.startsWith("data:image/webp")) {
          out = canvas.toDataURL("image/png"); // WebP unsupported → lossless fallback
        }
        resolve(out);
      };
      img.src = /** @type {string} */ (reader.result);
    };
    reader.readAsDataURL(file);
  });
}

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
  const [processing, setProcessing] = useState(false);
  const [imageError, setImageError] = useState("");
  const fileInputRef = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file after a removal
    if (!file) return;
    setImageError("");
    setProcessing(true);
    try {
      setBannerUrl(await fileToScaledDataUrl(file));
    } catch {
      setImageError("לא ניתן לטעון את התמונה. בחר/י קובץ תמונה תקין (עד 25MB).");
    } finally {
      setProcessing(false);
    }
  };

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
        <Label className="text-sm font-semibold">תמונת הקבוצה (לא חובה)</Label>
        {/* A fixed 16/9 frame keeps the layout stable; `object-contain` scales the
            whole image to fit it without cropping or distortion (the old
            `object-cover` truncated tall/square logos). */}
        {bannerUrl ? (
          <div
            className="relative rounded-xl overflow-hidden border bg-muted flex items-center justify-center"
            style={{ aspectRatio: "16 / 9" }}
          >
            <img
              src={bannerUrl}
              alt="תמונת הקבוצה"
              className="w-full h-full object-contain"
              onError={(e) => { e.currentTarget.style.opacity = "0.2"; }}
            />
            <button
              type="button"
              onClick={() => { setBannerUrl(""); setImageError(""); }}
              className="absolute top-2 right-2 bg-black/60 text-white rounded-full p-1 hover:bg-black/80"
              aria-label="הסר תמונה"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={processing}
              className="w-full rounded-xl border-2 border-dashed border-muted-foreground/30 bg-muted/40 hover:bg-muted/70 hover:border-muted-foreground/50 transition-colors flex flex-col items-center justify-center gap-2 text-muted-foreground disabled:opacity-60"
              style={{ aspectRatio: "16 / 9" }}
            >
              {processing ? (
                <>
                  <Loader2 className="w-7 h-7 animate-spin" />
                  <span className="text-sm font-medium">מעבד תמונה…</span>
                </>
              ) : (
                <>
                  <Upload className="w-7 h-7" />
                  <span className="text-sm font-medium">העלה תמונה</span>
                  <span className="text-xs opacity-70">PNG, JPG או WebP</span>
                </>
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFile}
            />
            <Input
              id="banner"
              value={bannerUrl}
              onChange={(e) => setBannerUrl(e.target.value)}
              placeholder="או הדבק כתובת תמונה (URL)..."
              className="h-11"
              dir="ltr"
            />
          </>
        )}
        {imageError && <p className="text-xs text-destructive">{imageError}</p>}
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
