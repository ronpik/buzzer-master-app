import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { base44 } from "@/api/base44Client";
import { Upload, X } from "lucide-react";

const PRESET_COLORS = [
  "#EF4444", "#F97316", "#EAB308", "#22C55E", 
  "#06B6D4", "#3B82F6", "#8B5CF6", "#EC4899",
  "#14B8A6", "#F59E0B", "#6366F1", "#D946EF"
];

export default function GroupForm({ group, onSave, onCancel }) {
  const [name, setName] = useState(group?.name || "");
  const [color, setColor] = useState(group?.color || PRESET_COLORS[0]);
  const [bannerUrl, setBannerUrl] = useState(group?.banner_url || "");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleBannerUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    const { file_url } = await base44.integrations.Core.UploadFile({ file });
    setBannerUrl(file_url);
    setUploading(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    await onSave({ name: name.trim(), color, banner_url: bannerUrl });
    setSaving(false);
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
        <Label className="text-sm font-semibold">באנר הקבוצה</Label>
        {bannerUrl ? (
          <div className="relative rounded-xl overflow-hidden border" style={{ aspectRatio: "16/9" }}>
            <img src={bannerUrl} alt="Banner" className="w-full h-full object-cover" />
            <button
              type="button"
              onClick={() => setBannerUrl("")}
              className="absolute top-2 right-2 bg-black/60 text-white rounded-full p-1 hover:bg-black/80"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <label className="flex flex-col items-center justify-center h-32 border-2 border-dashed rounded-xl cursor-pointer hover:bg-muted/50 transition-colors">
            <Upload className="w-6 h-6 text-muted-foreground mb-2" />
            <span className="text-sm text-muted-foreground">
              {uploading ? "מעלה..." : "לחץ להעלאת באנר"}
            </span>
            <input type="file" accept="image/*" onChange={handleBannerUpload} className="hidden" />
          </label>
        )}
      </div>

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={saving || !name.trim()} className="flex-1 h-11 text-base font-bold">
          {saving ? "שומר..." : group ? "עדכן" : "הוסף קבוצה"}
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