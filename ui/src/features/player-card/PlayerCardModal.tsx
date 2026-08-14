import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { Icon } from "../../design-system/Icon";
import { SectionTabs } from "../../design-system/SectionTabs";
import { ipc } from "../../ipc/client";
import type { PlayerRatingSummary, RatingHistoryPeriod } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { flagSrc } from "../../shared/countryFlags";
import { noteForPlayer } from "../../shared/playerNotes";
import { EMPTY_REPLAY_QUERY } from "../../shared/replayQuery";
import { PlayerAchievements } from "./PlayerAchievements";
import { PlayerClanView } from "./PlayerClanView";
import { PlayerOverview } from "./PlayerOverview";
import { PlayerNoteEditor } from "./PlayerNoteEditor";
import { OwnAvatarPicker } from "./OwnAvatarPicker";
import { PlayerStatistics } from "./PlayerStatistics";
import { RatingHistoryChart } from "./RatingHistoryChart";
import { closePlayerCard, openPlayerCard } from "./playerCardActions";
import { PlayerName } from "../../shared/nameColors";
import "./player-card.css";

type PlayerCardTab = "overview" | "ratings" | "statistics" | "achievements" | "names" | "clan";

const TABS: Array<{ id: PlayerCardTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "ratings", label: "Rating history" },
  { id: "statistics", label: "Statistics" },
  { id: "achievements", label: "Achievements" },
  { id: "names", label: "Previous names" },
  { id: "clan", label: "Clan" },
];

const PERIODS: Array<{ value: RatingHistoryPeriod; label: string }> = [
  { value: "day", label: "Last day" },
  { value: "week", label: "Last week" },
  { value: "month", label: "Last month" },
  { value: "year", label: "Last year" },
  { value: "all", label: "All time" },
];

function PlayerRatingHistory({ rating, onRatingChange, ratings }: {
  rating: PlayerRatingSummary;
  onRatingChange: (rating: PlayerRatingSummary) => void;
  ratings: PlayerRatingSummary[];
}) {
  const state = useAppStore((store) => store.state.playerCard);
  const [period, setPeriod] = useState<RatingHistoryPeriod>("all");
  const [showMaximum, setShowMaximum] = useState(true);
  const playerId = state.profile?.playerId ?? 0;
  const query = (page: number) => ({
    playerId,
    leaderboardId: rating.leaderboardId,
    leaderboard: rating.technicalName,
    period,
    page,
    pageSize: 10_000,
  });
  const load = (page = 1, append = false) => ipc.send({
    kind: "PlayerCard",
    command: { type: "loadHistory", payload: { query: query(page), append } },
  });

  useEffect(() => {
    ipc.send({
      kind: "PlayerCard",
      command: {
        type: "loadHistory",
        payload: {
          query: {
            playerId,
            leaderboardId: rating.leaderboardId,
            leaderboard: rating.technicalName,
            period,
            page: 1,
            pageSize: 10_000,
          },
          append: false,
        },
      },
    });
  }, [period, playerId, rating.leaderboardId, rating.technicalName]);

  const loadedMaximum = useMemo(() => state.history.reduce<number | null>((best, point) => {
    const value = Number(point.rating);
    return Number.isFinite(value) && (best === null || value > best) ? value : best;
  }, null), [state.history]);

  // "All-time" is only true when the server told us the peak. Falling back to
  // the maximum of one loaded page and still calling it all-time is how the old
  // tile claimed a number it had no way to know.
  const peak = state.historyMaximum?.rating ?? loadedMaximum ?? null;
  const peakIsAuthoritative = state.historyMaximum?.rating != null;
  const complete = state.historyPage >= state.historyTotalPages;
  const busy = state.historyStatus === "loading";

  return (
    <div className="player-history-view">
      <div className="player-history-toolbar">
        <label><span>Rating queue</span><select value={rating.leaderboardId} onChange={(event) => {
          const next = ratings.find((candidate) => candidate.leaderboardId === Number(event.target.value));
          if (next) onRatingChange(next);
        }}>{ratings.map((candidate) => <option key={candidate.leaderboardId} value={candidate.leaderboardId}>{candidate.name}</option>)}</select></label>
        <label><span>Period</span><select value={period} onChange={(event) => setPeriod(event.target.value as RatingHistoryPeriod)}>{PERIODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      </div>

      {/* Four facts about the player. The old strip spent one of its four
          tiles on "History entries", which describes the query rather than
          the player; that count now sits with the paging controls it belongs
          to. */}
      <div className="player-history-summary surface-panel">
        <div>
          <span>Current</span>
          <strong>{rating.rating}</strong>
          <small>{rating.name}</small>
        </div>
        <div>
          <span>{peakIsAuthoritative ? "All-time peak" : "Peak in loaded history"}</span>
          <strong>{peak?.toFixed(0) ?? "N/A"}</strong>
          {peak != null && <small>{peak - rating.rating >= 0 ? `${(peak - rating.rating).toFixed(0)} above current` : "current is a record"}</small>}
        </div>
        <div>
          <span>Games</span>
          <strong>{rating.gamesPlayed.toLocaleString("en-US")}</strong>
          <small>in this queue</small>
        </div>
        <div>
          <span>Deviation</span>
          <strong>±{rating.deviation?.toFixed(0) ?? "N/A"}</strong>
          <small>skill estimate {rating.mean?.toFixed(0) ?? "N/A"}</small>
        </div>
      </div>

      {state.historyStatus === "failed" && (
        // Retry lives here rather than as a permanent toolbar button: a rating
        // history is a near-static record, so a refresh control only has a job
        // when the load actually failed.
        <div className="player-card-error">
          <p>{state.historyError}</p>
          <Button onClick={() => load()}><Icon name="refresh" size={15} /> Try again</Button>
        </div>
      )}

      <div className="player-history-chart">
        <div className="player-history-chart-head">
          <span className="muted">Drag across the plot to measure a stretch of games.</span>
          <label className="player-card-toggle">
            <input type="checkbox" checked={showMaximum} onChange={(event) => setShowMaximum(event.target.checked)} />
            Peak line
          </label>
        </div>
        {busy && state.history.length === 0
          ? <div className="player-card-loading muted">Loading rating history…</div>
          : <RatingHistoryChart points={state.history} maximum={state.historyMaximum} showMaximum={showMaximum} />}
      </div>

      <div className="player-history-paging">
        <span className="muted">
          {busy && "Loading… "}
          {state.history.length.toLocaleString("en-US")} entries loaded
          {!complete && ` · page ${state.historyPage} of ${state.historyTotalPages}`}
        </span>
        {!complete && (
          <>
            <Button disabled={busy} onClick={() => load(state.historyPage + 1, true)}>Load next page</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => ipc.send({ kind: "PlayerCard", command: { type: "loadAllHistory", payload: { query: query(state.historyPage + 1) } } })}
            >
              Load complete history
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function PlayerCardModal() {
  const state = useAppStore((store) => store.state.playerCard);
  const me = useAppStore((store) => store.state.auth.player);
  const social = useAppStore((store) => store.state.social);
  const playerNotes = useAppStore((store) => store.state.settings.social.playerNotes);
  const [tab, setTab] = useState<PlayerCardTab>("overview");
  const [ratingId, setRatingId] = useState<number | null>(null);
  const [lookup, setLookup] = useState("");
  const [noteEditorOpen, setNoteEditorOpen] = useState(false);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const profile = state.profile;
  const knownPlayer = profile
    ? social.players.find((candidate) => candidate.id === profile.playerId)
      ?? social.players.find((candidate) => candidate.login.localeCompare(profile.login, undefined, { sensitivity: "base" }) === 0)
    : undefined;
  const country = profile?.country || knownPlayer?.country || "";

  useEffect(() => {
    if (!profile) return;
    setTab("overview");
    setRatingId(profile.ratings[0]?.leaderboardId ?? null);
    setLookup("");
    setNoteEditorOpen(false);
    setAvatarPickerOpen(false);
  }, [profile]);

  if (!state.open) return null;
  const rating = profile?.ratings.find((candidate) => candidate.leaderboardId === ratingId) ?? profile?.ratings[0] ?? null;
  const isMe = profile && me?.id === profile.playerId;
  const isFriend = profile ? social.friends.some((name) => name.localeCompare(profile.login, undefined, { sensitivity: "base" }) === 0) : false;
  const isFoe = profile ? social.foes.some((name) => name.localeCompare(profile.login, undefined, { sensitivity: "base" }) === 0) : false;
  const playerNote = profile ? noteForPlayer(playerNotes, profile.playerId) : "";
  const setRelation = (relation: "friend" | "foe", member: boolean) => profile && ipc.send({ kind: "Social", command: { type: "setRelation", payload: { playerId: profile.playerId, login: profile.login, relation, member } } });
  const openHistory = (next: PlayerRatingSummary) => { setRatingId(next.leaderboardId); setTab("ratings"); };
  const messagePlayer = async (login: string) => {
    await ipc.settle({ kind: "Chat", command: { type: "joinChannel", payload: { channel: login } } });
    await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "chat" } } });
    closePlayerCard();
  };
  const browseReplays = () => {
    if (!profile) return;
    ipc.send({ kind: "Replays", command: { type: "searchVault", payload: { query: { ...EMPTY_REPLAY_QUERY, player: profile.login, exactPlayer: true } } } });
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "replays" } } });
    closePlayerCard();
  };

  return (
    <Modal className="player-card-modal" onClose={() => void closePlayerCard()}>
      <div className="player-card-header">
        <div className="player-card-identity">
          {country && (
            <img
              src={flagSrc(country)}
              alt={country.toUpperCase()}
              width={16}
              height={16}
              decoding="async"
              draggable={false}
            />
          )}
          <div><span className="player-card-eyebrow">Player profile</span><h2><PlayerName name={profile?.login || state.requestedLogin || "Player"} /></h2></div>
        </div>
        <form className="player-card-lookup" onSubmit={(event) => { event.preventDefault(); if (lookup.trim()) void openPlayerCard(null, lookup.trim()); }}>
          <input value={lookup} onChange={(event) => setLookup(event.target.value)} placeholder="Investigate another player…" aria-label="Investigate another player" />
          <Button type="submit" disabled={!lookup.trim()}><Icon name="search" size={15} /> Search</Button>
        </form>
        {profile && <div className="player-card-actions">
          <Button onClick={() => void navigator.clipboard.writeText(profile.login)}>Copy name</Button>
          <Button onClick={browseReplays}>Replays</Button>
          {isMe && <Button onClick={() => setAvatarPickerOpen((open) => !open)}>Choose avatar</Button>}
          {!isMe && <Button onClick={() => void messagePlayer(profile.login)}>Message</Button>}
          {!isMe && <Button onClick={() => setRelation("friend", !isFriend)}>{isFriend ? "Remove friend" : "Add friend"}</Button>}
          {!isMe && <Button onClick={() => setRelation("foe", !isFoe)}>{isFoe ? "Remove foe" : "Mark foe"}</Button>}
        </div>}
      </div>

      {profile && noteEditorOpen && (
        <div className="player-note-inline-editor surface">
          <PlayerNoteEditor
            playerId={profile.playerId}
            login={profile.login}
            initialNote={playerNote}
            onClose={() => setNoteEditorOpen(false)}
          />
        </div>
      )}

      {profile && isMe && avatarPickerOpen && (
        <OwnAvatarPicker
          currentUrl={profile.avatars.find((avatar) => avatar.selected)?.url ?? ""}
          onClose={() => setAvatarPickerOpen(false)}
        />
      )}

      {state.profileStatus === "loading" && <div className="player-card-loading muted">Loading complete player profile…</div>}
      {state.profileStatus === "failed" && <div className="player-card-error"><p>{state.profileError}</p><Button onClick={() => void openPlayerCard(null, state.requestedLogin)}>Retry</Button></div>}
      {profile && (
        <>
          {/* Same underline strip as the Play and Chat tabs, rather than a row
              of pill buttons: these switch a view, they do not perform an
              action. */}
          <SectionTabs
            active={tab}
            ariaLabel="Player profile sections"
            className="player-card-tabs"
            items={TABS.map((item) => ({ id: item.id, label: item.label }))}
            onChange={setTab}
          />
          <div className="player-card-content">
            {tab === "overview" && <PlayerOverview profile={profile} note={playerNote} onEditNote={() => setNoteEditorOpen(true)} onOpenHistory={openHistory} />}
            {tab === "ratings" && rating && <PlayerRatingHistory rating={rating} ratings={profile.ratings} onRatingChange={(next) => setRatingId(next.leaderboardId)} />}
            {tab === "ratings" && !rating && <div className="player-card-empty muted">This player has no rating history.</div>}
            {tab === "statistics" && <PlayerStatistics profile={profile} />}
            {tab === "achievements" && <PlayerAchievements achievements={profile.achievements} />}
            {tab === "names" && <div className="player-names-view"><table className="surface-panel"><thead><tr><th>Name</th><th>Used until</th></tr></thead><tbody>{profile.names.map((record) => <tr key={`${record.name}-${record.changeTime}`}><td>{record.name}</td><td>{new Date(record.changeTime).toLocaleString("en-US")}</td></tr>)}</tbody></table>{profile.names.length === 0 && <p className="muted">No previous names.</p>}</div>}
            {tab === "clan" && <PlayerClanView clan={profile.clan} selfLogin={me?.name ?? ""} onMessageLeader={messagePlayer} />}
          </div>
        </>
      )}
    </Modal>
  );
}
