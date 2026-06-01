import React from "react";
import QRCode from "react-qr-code";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

export default function QRCodeModal({ open, onOpenChange, url, title, groupColor }) {
  const downloadQR = () => {
    const svg = document.getElementById("qr-svg");
    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const img = new Image();
    
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      const pngFile = canvas.toDataURL("image/png");
      
      const link = document.createElement("a");
      link.download = "qr-code.png";
      link.href = pngFile;
      link.click();
    };
    
    img.src = "data:image/svg+xml;base64," + btoa(svgData);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle className="text-right">{title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-6 py-6">
          <div 
            className="p-4 rounded-2xl"
            style={{ backgroundColor: groupColor || "hsl(var(--card))" }}
          >
            <div id="qr-svg" className="bg-white p-4 rounded-xl">
              <QRCode value={url} size={200} />
            </div>
          </div>
          <p className="text-sm text-muted-foreground text-center dir-ltr break-all">
            {url}
          </p>
          <Button onClick={downloadQR} variant="outline" className="gap-2">
            <Download className="w-4 h-4" />
            הורד QR
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}