import { Toaster } from "@/components/ui/toaster"
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import Admin from './pages/Admin';
import BuzzerJoin from './pages/BuzzerJoin';
import BuzzerPlay from './pages/BuzzerPlay';
import Display from './pages/Display';

// App shell for the local, offline buzzer (DESIGN.md §13).
//
// The Base44 data/auth layer is gone: there is no QueryClientProvider, no
// AuthProvider, and no auth gating. This is a single trusted LAN with the admin
// served only on the host (DESIGN.md §2, §8), so every route renders directly and
// each page opens its own WebSocket to the server-side authority via the shared
// store (src/store.js). Routes are preserved 1:1 from the previous app:
//   /                → Admin (host only)
//   /play            → BuzzerJoin (team picker fallback during provisioning)
//   /play/:groupId   → BuzzerPlay (the tablet buzzer, team pinned per device)
//   /display         → Display (big-screen view, HDMI to the projector)

/** Minimal, dependency-free 404 (replaces the old Base44/React-Query one). */
function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-neutral-950">
      <div className="text-center" dir="rtl">
        <h1 className="text-7xl font-light text-white/30">404</h1>
        <p className="mt-4 text-white/50">הדף לא נמצא</p>
        <button
          onClick={() => { window.location.href = '/'; }}
          className="mt-6 inline-flex items-center px-4 py-2 text-sm font-medium text-white/80 bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
        >
          חזרה לניהול
        </button>
      </div>
    </div>
  );
}

function App() {
  return (
    <>
      <Router>
        <Routes>
          <Route path="/" element={<Admin />} />
          <Route path="/play" element={<BuzzerJoin />} />
          <Route path="/play/:groupId" element={<BuzzerPlay />} />
          <Route path="/display" element={<Display />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Router>
      <Toaster />
    </>
  );
}

export default App
