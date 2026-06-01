import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Activity, Wifi, WifiOff, Clock, Trophy } from "lucide-react";

// Admin diagnostics panel (DESIGN.md §13, §16). Surfaces the live signals the
// store actually carries:
//   - this host/admin connection + clock-sync state (connection, offset, RTT),
//   - per-team connection dots (presence = the live socket),
//   - the last decided round's full ranking with inter-press deltas
//     ("Team B +4 ms behind Team A") so close calls are transparent (§16).
//
// All values come from the WS-fed store; nothing is fetched. Per-tablet offset/
// RTT is not broadcast by the server in the current protocol, so we report this
// admin client's own sync quality (a proxy for LAN health) plus the press-time
// deltas, which are the figures that actually decide a winner.

/** Format an ms value with a sign, for offset/delta display. */
function fmtSigned(ms) {
  const v = Math.round(ms);
  return `${v >= 0 ? "+" : ""}${v}ms`;
}

export default function Diagnostics({ connection, teams = [], connected = [], ranking = [] }) {
  const { connection: conn, synced, clockOffset, lastRtt } = connection;
  const isOpen = conn === "open";

  const teamById = new Map(teams.map((t) => [t.id, t]));

  // Build ranking rows with the delta behind the winner (ranking[0] = winner).
  const winnerPressAt = ranking.length > 0 ? ranking[0].pressAt : null;
  const rankRows = ranking.map((entry) => {
    const team = teamById.get(entry.teamId);
    return {
      ...entry,
      name: team?.name ?? entry.teamId,
      color: team?.color ?? "#9ca3af",
      deltaMs: winnerPressAt != null ? entry.pressAt - winnerPressAt : 0,
    };
  });

  return (
    <Card className="border-2" dir="rtl">
      <CardContent className="p-6 space-y-6">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold">אבחון ומדידות</h2>
        </div>

        {/* Host connection + clock sync */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-xl border bg-card p-3 flex items-center gap-3">
            {isOpen ? (
              <Wifi className="w-5 h-5 text-green-500 shrink-0" />
            ) : (
              <WifiOff className="w-5 h-5 text-red-500 shrink-0" />
            )}
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">חיבור שרת</p>
              <p className="font-bold text-sm">
                {isOpen ? "מחובר" : conn === "connecting" ? "מתחבר..." : "מנותק"}
              </p>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-3 flex items-center gap-3">
            <Clock className={`w-5 h-5 shrink-0 ${synced ? "text-green-500" : "text-amber-500"}`} />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">סנכרון שעון</p>
              <p className="font-bold text-sm" dir="ltr">
                {synced ? `${fmtSigned(clockOffset)}` : "מסנכרן..."}
              </p>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-3 flex items-center gap-3">
            <Activity className="w-5 h-5 text-blue-500 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">RTT (הלוך־ושוב)</p>
              <p className="font-bold text-sm" dir="ltr">
                {synced ? `${lastRtt.toFixed(1)}ms` : "—"}
              </p>
            </div>
          </div>
        </div>

        {/* Per-team presence */}
        <div>
          <p className="text-sm font-semibold mb-2">
            חיבור טאבלטים ({connected.length} / {teams.length})
          </p>
          {teams.length === 0 ? (
            <p className="text-sm text-muted-foreground">אין קבוצות עדיין.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {teams.map((t) => {
                const online = connected.includes(t.id);
                return (
                  <div
                    key={t.id}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium border"
                    style={{ opacity: online ? 1 : 0.5 }}
                  >
                    <span className="w-3 h-3 rounded-full" style={{ backgroundColor: t.color }} />
                    <span>{t.name}</span>
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: online ? "#22C55E" : "#9ca3af" }}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Last round ranking + inter-press deltas */}
        <div>
          <p className="text-sm font-semibold mb-2 flex items-center gap-1.5">
            <Trophy className="w-4 h-4 text-amber-500" />
            דירוג הסיבוב האחרון
          </p>
          {rankRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">עדיין אין תוצאות לסיבוב.</p>
          ) : (
            <div className="space-y-1.5">
              {rankRows.map((row) => (
                <div
                  key={row.teamId}
                  className="flex items-center gap-3 rounded-lg border px-3 py-2"
                  style={row.rank === 1 ? { borderColor: row.color, backgroundColor: row.color + "11" } : undefined}
                >
                  <span className="font-black text-sm w-6 text-center text-muted-foreground">#{row.rank}</span>
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: row.color }} />
                  <span className="font-bold text-sm flex-1 truncate">{row.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums" dir="ltr">
                    {row.rank === 1 ? "🏆 ראשון" : `${fmtSigned(row.deltaMs)} אחרי`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
