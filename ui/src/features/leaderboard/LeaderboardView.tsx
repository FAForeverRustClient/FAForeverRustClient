// Leaderboard tab — two parallel ranking systems (mirrors both reference
// clients, see faf-domain's leaderboard module docs): a "Global" tab with a
// flat rating list (Python client's LeaderboardWidget), and one tab per
// ladder bracket (1v1/2v2/3v3/4v4) with league/season/division rankings, a
// division filter dropdown, each player's underlying rating, a "your rank"
// hero card, and a division distribution chart (Java client's
// theme/leaderboard/ views, incl. leaderboard_player_details.fxml and
// leaderboard_distribution.fxml). Pure: select state + dispatch commands,
// same posture as MapsView.tsx/ReplaysView.tsx.

import { useEffect, useMemo, useState } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { Button } from "../../design-system/Button";
import type { LeaderboardEntry, LeaderboardStatus } from "../../ipc/bindings";

const GLOBAL_TAB = "global" as const;
type TabKey = typeof GLOBAL_TAB | number;

const loadLeagues = () => ipc.dispatch({ kind: "Leaderboard", command: { type: "loadLeagues" } });

const selectLeague = (leagueId: number) =>
  ipc.dispatch({
    kind: "Leaderboard",
    command: { type: "selectLeague", payload: { leagueId } },
  });

const loadGlobal = () => ipc.dispatch({ kind: "Leaderboard", command: { type: "loadGlobal" } });

function loadNote(status: LeaderboardStatus, loadingLabel: string, failedPrefix: string): string | null {
  switch (status.type) {
    case "idle":
    case "ready":
      return null;
    case "loading":
      return loadingLabel;
    case "failed":
      return `${failedPrefix}: ${status.payload.reason}`;
  }
}

/** Highest division first (see `LeaderboardEntry.divisionOrder`'s docs). */
function byDivisionThenScore(a: LeaderboardEntry, b: LeaderboardEntry): number {
  const orderDiff = (b.divisionOrder ?? -1) - (a.divisionOrder ?? -1);
  if (orderDiff !== 0) return orderDiff;
  return (b.score ?? 0) - (a.score ?? 0);
}

function RankingsTable({ entries, showLadderColumns }: { entries: LeaderboardEntry[]; showLadderColumns: boolean }) {
  return (
    <table className="leaderboard-table">
      <thead>
        <tr>
          <th>Rank</th>
          <th>Player</th>
          {showLadderColumns && <th>Division</th>}
          {showLadderColumns && <th>Score</th>}
          <th>Rating</th>
          <th>Games Played</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.rank}>
            <td className="leaderboard-rank">{entry.rank}</td>
            <td>{entry.playerName}</td>
            {showLadderColumns && <td>{entry.division ?? "—"}</td>}
            {showLadderColumns && <td>{entry.score ?? "—"}</td>}
            <td>{entry.rating ?? "—"}</td>
            <td>{entry.gamesPlayed}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HeroCard({ entry, showDivision }: { entry: LeaderboardEntry; showDivision: boolean }) {
  return (
    <div className="leaderboard-hero">
      <div className="leaderboard-hero-rank">#{entry.rank}</div>
      <div className="leaderboard-hero-body">
        <div className="leaderboard-hero-name">{entry.playerName}</div>
        {showDivision && entry.division && <div className="muted">{entry.division}</div>}
      </div>
      <div className="leaderboard-hero-stats">
        {entry.score !== null && (
          <div>
            <span className="leaderboard-hero-stat-value">{entry.score}</span>
            <span className="muted"> score</span>
          </div>
        )}
        <div>
          <span className="leaderboard-hero-stat-value">{entry.rating ?? "—"}</span>
          <span className="muted"> rating</span>
        </div>
        <div>
          <span className="leaderboard-hero-stat-value">{entry.gamesPlayed}</span>
          <span className="muted"> games</span>
        </div>
      </div>
    </div>
  );
}

function DivisionDistribution({ entries, divisions }: { entries: LeaderboardEntry[]; divisions: string[] }) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) {
      if (e.division) m.set(e.division, (m.get(e.division) ?? 0) + 1);
    }
    return m;
  }, [entries]);
  const max = Math.max(1, ...counts.values());

  if (divisions.length === 0) return null;

  return (
    <div className="leaderboard-distribution">
      {divisions.map((d) => {
        const count = counts.get(d) ?? 0;
        return (
          <div key={d} className="leaderboard-distribution-row">
            <span className="leaderboard-distribution-label">{d}</span>
            <div className="leaderboard-distribution-track">
              <div className="leaderboard-distribution-bar" style={{ width: `${(count / max) * 100}%` }} />
            </div>
            <span className="leaderboard-distribution-count muted">{count}</span>
          </div>
        );
      })}
    </div>
  );
}

export function LeaderboardView() {
  const leagues = useAppStore((s) => s.state.leaderboard.leagues);
  const leaguesStatus = useAppStore((s) => s.state.leaderboard.leaguesStatus);
  const entries = useAppStore((s) => s.state.leaderboard.entries);
  const entriesStatus = useAppStore((s) => s.state.leaderboard.entriesStatus);
  const globalEntries = useAppStore((s) => s.state.leaderboard.globalEntries);
  const globalStatus = useAppStore((s) => s.state.leaderboard.globalStatus);
  const myPlayer = useAppStore((s) => s.state.auth.player);

  const [activeTab, setActiveTab] = useState<TabKey>(GLOBAL_TAB);
  const [search, setSearch] = useState("");
  const [division, setDivision] = useState<string>("all");

  const leaguesNote = loadNote(leaguesStatus, "Loading leagues…", "Could not load leagues");

  useEffect(() => {
    if (useAppStore.getState().state.leaderboard.leaguesStatus.type === "idle") {
      loadLeagues();
    }
    if (useAppStore.getState().state.leaderboard.globalStatus.type === "idle") {
      loadGlobal();
    }
  }, []);

  // Selecting a tab clears any division filter carried over from a
  // different ladder bracket and (for a ladder tab) loads its entries.
  const chooseTab = (tab: TabKey) => {
    setActiveTab(tab);
    setDivision("all");
    if (tab !== GLOBAL_TAB) {
      selectLeague(tab);
    }
  };

  const isGlobal = activeTab === GLOBAL_TAB;
  const status = isGlobal ? globalStatus : entriesStatus;
  const statusNote = loadNote(
    status,
    isGlobal ? "Loading global rating…" : "Loading rankings…",
    isGlobal ? "Could not load global rating" : "Could not load rankings",
  );
  const activeEntries = isGlobal ? globalEntries : entries;

  // Unique divisions present in the current league's entries, highest tier
  // first (mirrors the Java client's distribution chart ordering).
  const divisions = useMemo(() => {
    const order = new Map<string, number>();
    for (const e of entries) {
      if (e.division) order.set(e.division, e.divisionOrder ?? 0);
    }
    return [...order.keys()].sort((a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0));
  }, [entries]);

  const myEntry = useMemo(() => {
    if (!myPlayer) return null;
    return activeEntries.find((e) => e.playerName === myPlayer.name) ?? null;
  }, [activeEntries, myPlayer]);

  const filteredEntries = useMemo(() => {
    let result = activeEntries;
    if (!isGlobal && division !== "all") {
      result = result.filter((e) => e.division === division);
    } else if (!isGlobal) {
      // "All divisions": group highest-division-first rather than the
      // backend's flat by-score order.
      result = [...result].sort(byDivisionThenScore);
    }
    const needle = search.trim().toLowerCase();
    if (needle) {
      result = result.filter((e) => e.playerName.toLowerCase().includes(needle));
    }
    return result;
  }, [activeEntries, isGlobal, division, search]);

  return (
    <div className="lobby">
      <div className="lobby-head">
        <h2>Leaderboard</h2>
        {leaguesNote && <span className="join-note muted">{leaguesNote}</span>}
      </div>

      <div className="lobby-head">
        <Button variant={activeTab === GLOBAL_TAB ? "primary" : "ghost"} onClick={() => chooseTab(GLOBAL_TAB)}>
          Global
        </Button>
        {leagues.map((league) => (
          <Button
            key={league.id}
            variant={activeTab === league.id ? "primary" : "ghost"}
            onClick={() => chooseTab(league.id)}
          >
            {league.technicalName}
          </Button>
        ))}
        <span className="spacer" />
        {!isGlobal && divisions.length > 0 && (
          <select
            className="leaderboard-search"
            value={division}
            onChange={(e) => setDivision(e.target.value)}
          >
            <option value="all">All divisions</option>
            {divisions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
        <input
          className="leaderboard-search"
          type="text"
          placeholder="Search player…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {myEntry && <HeroCard entry={myEntry} showDivision={!isGlobal} />}

      {!isGlobal && status.type === "ready" && entries.length > 0 && (
        <DivisionDistribution entries={entries} divisions={divisions} />
      )}

      {statusNote && <p className="muted">{statusNote}</p>}
      {status.type === "ready" && activeEntries.length === 0 && (
        <p className="muted">
          {isGlobal ? "No active players found." : "No active season for this league right now."}
        </p>
      )}
      {status.type === "ready" && activeEntries.length > 0 && filteredEntries.length === 0 && (
        <p className="muted">No players match the current filters.</p>
      )}
      {filteredEntries.length > 0 && (
        <RankingsTable entries={filteredEntries} showLadderColumns={!isGlobal} />
      )}
    </div>
  );
}
