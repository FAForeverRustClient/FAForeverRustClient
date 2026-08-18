import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { ipc } from "../../ipc/client";
import type { MatchmakerQueue, MatchmakingState, PartyState } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { MatchmakerMapPoolModal } from "./MatchmakerMapPoolModal";
import { MatchmakerPartyChat } from "./MatchmakerPartyChat";
import { MatchmakerPartyPanel } from "./MatchmakerPartyPanel";
import { MatchmakerPlayerCard } from "./MatchmakerPlayerCard";
import { MatchmakerQueueCard, queueTitle, type QueueDisplayState } from "./MatchmakerQueueCard";
import { ratingForQueue } from "./matchmakerRatings";
import "./matchmaker.css";
import { t } from "../../i18n";
import { useLocale } from "../../i18n/useTranslation";

function stateForQueue(state: MatchmakingState, queueName: string): QueueDisplayState {
  switch (state.type) {
    case "searching": return state.payload.queueNames.includes(queueName) ? "searching" : "idle";
    case "matchFound": return state.payload.queueName === queueName ? "found" : "idle";
    case "launching": return state.payload.queueName === queueName ? "launching" : "idle";
    case "cancelled": return state.payload.queueName === null || state.payload.queueName === queueName ? "cancelled" : "idle";
    case "idle": return "idle";
  }
}

function searchingQueues(state: MatchmakingState) {
  return state.type === "searching" ? state.payload.queueNames : [];
}

function MatchmakerSearchSummary({ state, selectedCount }: { state: MatchmakingState; selectedCount: number }) {
  if (state.type === "idle") return <span>{t("lobby.matchmaker.summary.selected", { count: selectedCount })}</span>;
  if (state.type === "searching") return <span>{t("lobby.matchmaker.summary.searching", { count: state.payload.queueNames.length })}</span>;
  if (state.type === "matchFound") return <span>{t("lobby.matchmaker.summary.found", { queue: state.payload.queueName })}</span>;
  if (state.type === "launching") return <span>{t("lobby.matchmaker.summary.launching")}</span>;
  return <span>{t("lobby.matchmaker.cancelled")}</span>;
}

export function MatchmakingPanel({ queues, matchmaking, party }: { queues: MatchmakerQueue[]; matchmaking: MatchmakingState; party: PartyState }) {
  useLocale();
  const maps = useAppStore((state) => state.state.maps);
  const social = useAppStore((state) => state.state.social);
  const liveGames = useAppStore((state) => state.state.lobby.liveGames);
  const serverVetoes = useAppStore((state) => state.state.lobby.vetoes);
  const player = useAppStore((state) => state.state.auth.player);
  const playerCard = useAppStore((state) => state.state.playerCard);
  const browsing = useAppStore((state) => state.state.settings.browsing);
  const [unselectedQueues, setUnselectedQueues] = useState<string[]>(browsing.matchmakerUnselectedQueues);
  const [selectedFactions, setSelectedFactions] = useState<string[]>(browsing.matchmakerFactions);
  const [mapPoolQueueName, setMapPoolQueueName] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [queueClocks, setQueueClocks] = useState<Record<string, { seconds: number; receivedAt: number }>>({});
  const requestedProfileId = useRef<number | null>(null);

  const sortedQueues = useMemo(() => [...queues].sort((left, right) => left.teamSize - right.teamSize || left.queueName.localeCompare(right.queueName)), [queues]);
  const selectedQueues = sortedQueues.filter((queue) => !unselectedQueues.includes(queue.queueName));
  const activeSearches = useMemo(() => searchingQueues(matchmaking), [matchmaking]);
  const isSearching = activeSearches.length > 0;
  const searchLocked = matchmaking.type === "matchFound" || matchmaking.type === "launching";
  const playerId = player?.id ?? null;
  const playerName = player?.name ?? t("lobby.matchmaker.player");
  const partyNeedsLeader = party.members.length > 1 && party.ownerId !== playerId;
  const compatibleQueues = selectedQueues.filter((queue) => party.members.length <= queue.teamSize);
  const mapPoolQueue = sortedQueues.find((queue) => queue.queueName === mapPoolQueueName) ?? null;
  const matchmakerProfile = playerCard.matchmakerProfile?.playerId === playerId
    ? playerCard.matchmakerProfile
    : null;

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const receivedAt = Date.now();
    setQueueClocks((current) => Object.fromEntries(queues.map((queue) => {
      const previous = current[queue.queueName];
      return [queue.queueName, previous?.seconds === queue.queuePopTimeSeconds
        ? previous
        : { seconds: queue.queuePopTimeSeconds, receivedAt }];
    })));
  }, [queues]);

  useEffect(() => {
    setUnselectedQueues(browsing.matchmakerUnselectedQueues);
    setSelectedFactions(browsing.matchmakerFactions);
  }, [browsing.matchmakerFactions, browsing.matchmakerUnselectedQueues]);

  useEffect(() => {
    if (playerId === null) return;
    if (requestedProfileId.current === playerId) return;
    if (playerCard.matchmakerProfile?.playerId === playerId && playerCard.matchmakerProfileStatus === "ready") return;
    requestedProfileId.current = playerId;
    ipc.send({
      kind: "PlayerCard",
      command: {
        type: "loadMatchmakerProfile",
        payload: { playerId, login: playerName },
      },
    });
  }, [playerCard.matchmakerProfile, playerCard.matchmakerProfileStatus, playerId, playerName]);

  useEffect(() => {
    // A party can grow while it is queued. The Java client immediately leaves
    // queues that no longer fit instead of waiting for a server rejection.
    activeSearches.forEach((queueName) => {
      const queue = queues.find((candidate) => candidate.queueName === queueName);
      if (queue && party.members.length > queue.teamSize) {
        ipc.send({ kind: "Lobby", command: { type: "matchmake", payload: { queueName, start: false } } });
      }
    });
  }, [activeSearches, party.members.length, queues]);

  const setFactions = (factions: string[]) => {
    setSelectedFactions(factions);
    ipc.send({
      kind: "Settings",
      command: {
        type: "setBrowsing",
        payload: { preferences: { ...browsing, matchmakerFactions: factions } },
      },
    });
    ipc.send({ kind: "Lobby", command: { type: "setPartyFactions", payload: { factions } } });
  };

  const toggleQueue = (queue: MatchmakerQueue) => {
    const selected = !unselectedQueues.includes(queue.queueName);
    const next = selected
      ? [...unselectedQueues, queue.queueName]
      : unselectedQueues.filter((name) => name !== queue.queueName);
    setUnselectedQueues(next);
    ipc.send({
      kind: "Settings",
      command: {
        type: "setBrowsing",
        payload: { preferences: { ...browsing, matchmakerUnselectedQueues: next } },
      },
    });

    if (isSearching) {
      ipc.send({ kind: "Lobby", command: { type: "matchmake", payload: { queueName: queue.queueName, start: !selected } } });
    }
  };

  const toggleSearch = () => {
    if (isSearching) {
      activeSearches.forEach((queueName) => ipc.send({ kind: "Lobby", command: { type: "matchmake", payload: { queueName, start: false } } }));
      return;
    }

    ipc.send({ kind: "Lobby", command: { type: "setPartyFactions", payload: { factions: selectedFactions } } });
    compatibleQueues.forEach((queue) => ipc.send({ kind: "Lobby", command: { type: "matchmake", payload: { queueName: queue.queueName, start: true } } }));
  };

  const openMapPool = (queue: MatchmakerQueue) => {
    setMapPoolQueueName(queue.queueName);
    ipc.send({ kind: "Maps", command: { type: "loadMatchmakerPools", payload: { queueName: queue.queueName } } });
  };

  if (queues.length === 0) {
    return <EmptyState icon="users" title={t("lobby.matchmaker.loading")} hint={t("lobby.matchmaker.loadingHint")} />;
  }

  const canSearch = !partyNeedsLeader && compatibleQueues.length > 0 && !searchLocked;
  const activeMatchmakerGames = liveGames.filter((game) => game.gameType.toLocaleLowerCase() === "matchmaker");

  return (
    <div className="matchmaking-layout">
      <main className="matchmaker-main">
        <MatchmakerPlayerCard
          playerId={playerId}
          playerName={playerName}
          profile={matchmakerProfile}
          status={playerCard.matchmakerProfileStatus}
          error={playerCard.matchmakerProfileError}
          country={social.players.find((entry) => entry.id === playerId)?.country ?? ""}
          factions={selectedFactions}
          disabled={isSearching || searchLocked || partyNeedsLeader}
          onFactionsChange={setFactions}
        />

        <MatchmakerPartyPanel party={party} social={social} playerId={playerId} playerName={playerName} searching={isSearching || searchLocked} />

        <section className="matchmaker-card surface-panel matchmaker-queues-section" aria-labelledby="matchmaker-queues-title">
          <div className="matchmaker-section-copy">
            <div><span className="matchmaker-kicker">{t("lobby.matchmaker.gameModes")}</span><h2 id="matchmaker-queues-title">{t("lobby.matchmaker.selectQueues")}</h2></div>
            {/* Only says something when it is not obvious from the cards: a
                party has a size floor that silently disables some of them. */}
            {party.members.length > 1 && (
              <p>{`Your ${party.members.length}-player party can enter queues sized ${party.members.length} vs ${party.members.length} or larger.`}</p>
            )}
          </div>
          <div className="matchmaker-queue-grid">
            {sortedQueues.map((queue) => {
              const clockState = queueClocks[queue.queueName];
              const remaining = clockState ? Math.max(0, clockState.seconds - Math.floor((clock - clockState.receivedAt) / 1000)) : queue.queuePopTimeSeconds;
              const activeGames = activeMatchmakerGames.filter((game) => game.maxPlayers === queue.teamSize * 2).length;
              return (
                <MatchmakerQueueCard
                  key={queue.queueName}
                  queue={queue}
                  selected={!unselectedQueues.includes(queue.queueName)}
                  disabled={partyNeedsLeader || party.members.length > queue.teamSize || searchLocked}
                  status={stateForQueue(matchmaking, queue.queueName)}
                  activeGames={activeGames}
                  secondsUntilPop={remaining}
                  rating={ratingForQueue(matchmakerProfile?.ratings ?? [], queue.queueName)}
                  onToggle={() => toggleQueue(queue)}
                  onOpenMapPool={() => openMapPool(queue)}
                />
              );
            })}
          </div>

          {/* The search control belongs to the queues it acts on. As its own
              floating strip below the card it read as a detached toolbar, and
              nothing tied "4 queues selected" to the four cards above it. */}
          <div className={`matchmaker-search-bar${matchmaking.type === "cancelled" ? " cancelled" : ""}`} data-state={matchmaking.type}>
            <div className="matchmaker-search-copy">
              <i />
              <div>
                <strong><MatchmakerSearchSummary state={matchmaking} selectedCount={compatibleQueues.length} /></strong>
                <span>{isSearching
                  ? t("lobby.matchmaker.hint.editable")
                  : compatibleQueues.length === 0
                    ? t("lobby.matchmaker.hint.selectOne")
                    : t("lobby.matchmaker.hint.filesChecked")}</span>
              </div>
            </div>
            <Button variant="primary" className="matchmaker-search-button" disabled={partyNeedsLeader || (!isSearching && !canSearch)} onClick={toggleSearch}>
              {isSearching ? t("lobby.matchmaker.stopSearching") : searchLocked ? matchmaking.type === "matchFound" ? t("lobby.matchmaker.state.found") : t("lobby.matchmaker.state.launching") : t("lobby.matchmaker.startSearch")}
            </Button>
          </div>
        </section>
      </main>

      {/* Java devotes the whole right half of this tab to the matchmaking chat
          (`team_matchmaking.fxml` puts `matchmaking_chat.fxml` in column 2), and
          it is there whether or not you have company. Rendering it only for a
          real party left this tab looking half-finished for the solo player who
          most needs somewhere to find teammates. */}
      <MatchmakerPartyChat party={party} />

      {mapPoolQueue && (
        <MatchmakerMapPoolModal
          queueTitle={queueTitle(mapPoolQueue)}
          pools={maps.matchmakerPools[mapPoolQueue.queueName] ?? []}
          status={maps.matchmakerPoolsStatus}
          vault={maps.vault}
          serverVetoes={serverVetoes}
          onClose={() => setMapPoolQueueName(null)}
        />
      )}
    </div>
  );
}
