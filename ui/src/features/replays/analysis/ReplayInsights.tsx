import { StatusNotice } from "../../../design-system/StatusNotice";
import { plainError } from "../../../shared/plainError";
// Everything a replay file says that the detail panel has no room for, in one
// overlay with tabs across the top.
//
// It used to be a button called "Load more info" that unfolded two tables
// underneath the panel, below the fold: the report was that you had to scroll
// for it and that what you found there was squeezed into a column. The three
// things it held (the game's options, its chat log, its simulation mods) are
// the same three things here, each with the width of the dialog to itself, plus
// the one the file has always carried and nothing ever read: how many orders
// each player gave.
//
// Drawn over the replay panel rather than as a second `Modal`, and one layer
// of the overlay stack while open: Escape closes this and leaves the replay
// open, and a list open inside it (the chat's "From") closes before it does.
// The same three ways out as a dialog: the button, the scrim and Escape.

import { useId, useMemo, useState } from "react";
import { Icon } from "../../../design-system/Icon";
import { SectionTabs, sectionPanelProps } from "../../../design-system/SectionTabs";
import { useOverlayLayer } from "../../../design-system/useOverlayLayer";
import type {
  ReplayAnalysis,
  ReplayDetails,
  ReplayTeam,
} from "../../../ipc/bindings";
import { ReplayActivityChart } from "./ReplayActivityChart";
import { ReplayBuildOrderPane } from "./ReplayBuildOrderPane";
import { formatGameTime } from "./replayAnalysis";
import { ReplayEventsPanel, ReplayPlayersPanel } from "./ReplayAnalysisPanels";
import { ReplayGameStats } from "./ReplayGameStats";
import { gameOptionLabel } from "./gameOptionLabels";
import { ReplayHeatmap, type HeatmapMapAction } from "./ReplayHeatmap";
import { useTranslation } from "../../../i18n/useTranslation";
import { ipc } from "../../../ipc/client";
import { ReplayChatPane, useReplayChat } from "./ReplayChatPane";
import { ReplayActivityPane } from "./ReplayActivityPane";
import { ReplayOptionsPane } from "./ReplayOptionsPane";
import { activityRows } from "./replayInsightRows";
export { activityRows, chatSenders, formatChatTime, isTransferMessage } from "./replayInsightRows";
import { requestModVaultFocus } from "../../../shared/modVaultFocus";

function openModInVault(mod: string) {
  requestModVaultFocus(mod);
  ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "mods" } } });
}

type InsightTab =
  | "options"
  | "chat"
  | "players"
  | "buildOrder"
  | "events"
  | "graph"
  | "heatmap"
  | "stats"
  | "mods";

/** The tabs that need the whole command stream rather than the cheap read. */
const ANALYSIS_TABS: ReadonlySet<InsightTab> = new Set<InsightTab>([
  "buildOrder",
  "events",
  "graph",
  "heatmap",
  "stats",
]);

export function ReplayInsights({
  details,
  analysis,
  analysisLoading,
  analysisError,
  teams,
  title,
  mapPreviewUrl,
  mapAction,
  loading,
  error,
  onClose,
  onRetry,
}: {
  /**
   * `null` until the replay file has been read.
   *
   * The panel opens on the click rather than on the answer. A vault replay
   * that is not on disk yet has to be downloaded first, and the button used to
   * sit there disabled with nothing else happening: "load more infos in
   * replays passiert lange zeit garnichts". It now opens immediately and says
   * what it is waiting for.
   */
  details: ReplayDetails | null;
  /**
   * The whole command stream, which is the expensive read.
   *
   * `null` until it lands, and it lands behind the details: the options and
   * the chat are what the panel opens on, and everything a reader has to wait
   * for is behind a tab that says it is still reading.
   */
  analysis: ReplayAnalysis | null;
  analysisLoading: boolean;
  analysisError: string;
  /** The lineup, for the faction and rating beside a command count. */
  teams: ReplayTeam[];
  /** The game being looked at, for the dialog's heading. */
  title: string;
  /** The map, for the heatmap to draw its cells over. */
  mapPreviewUrl?: string;
  /** How to build that map, where there is no picture of it yet. */
  mapAction?: HeatmapMapAction;
  loading: boolean;
  error: string;
  onClose: () => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<InsightTab>("options");
  const [optionFilter, setOptionFilter] = useState("");
  useOverlayLayer(true, onClose);
  const tabsId = useId();

  // Absent on a file whose stream could not be walked, and on a legacy
  // `.scfareplay` with no header in front of it.
  const simMods = details?.simMods ?? [];
  const gameOptions = details?.gameOptions ?? [];
  // Memoised rather than defaulted inline: an empty array literal is a new
  // value on every render, and two of the filters below are keyed on it.
  const chatMessages = useMemo(() => details?.chatMessages ?? [], [details?.chatMessages]);
  const chat = useReplayChat(chatMessages);
  const rows = useMemo(
    () => activityRows(details?.commandStats ?? [], teams, details?.simSeconds ?? 0),
    [details?.commandStats, details?.simSeconds, teams],
  );

  const filteredOptions = useMemo(() => {
    const options = details?.gameOptions ?? [];
    const query = optionFilter.trim().toLowerCase();
    if (!query) return options;
    return options.filter(
      (option) =>
        option.key.toLowerCase().includes(query) ||
        gameOptionLabel(option.key).toLowerCase().includes(query) ||
        option.value.toLowerCase().includes(query),
    );
  }, [details?.gameOptions, optionFilter]);

  // Counts only once there is something to count: a tab reading "Chat 0"
  // while the file is still being read says the game had no chat.
  const count = (value: number) => (details ? value : undefined);
  const tabs = [
    { id: "options" as const, label: t("replays.detail.gameOptions"), count: count(gameOptions.length) },
    { id: "chat" as const, label: t("replays.detail.chat"), count: count(chatMessages.length) },
    { id: "players" as const, label: t("replays.insights.activity"), count: count(rows.length) },
    { id: "buildOrder" as const, label: t("replays.buildOrder.tab") },
    { id: "events" as const, label: t("replays.insights.events"), count: analysis?.notices.length },
    { id: "graph" as const, label: t("replays.insights.graph") },
    { id: "heatmap" as const, label: t("replays.insights.heatmap") },
    { id: "stats" as const, label: t("replays.insights.gameStats"), count: analysis?.stats.length },
    ...(simMods.length > 0
      ? [{ id: "mods" as const, label: t("replays.detail.simMods"), count: simMods.length }]
      : []),
  ];

  // A tab that needs the stream says so itself rather than leaving the reader
  // in front of an empty panel.
  const waitingForAnalysis = ANALYSIS_TABS.has(tab) && !analysis;
  const failure = (reason: string) => (
    <StatusNotice tone="error" detail={reason}
      action={onRetry ? { label: t("common.retry"), onClick: onRetry } : undefined}>
      {plainError(reason)}
    </StatusNotice>
  );
  const analysisNotice = waitingForAnalysis
    ? (
      analysisError
        ? failure(analysisError)
        : (
          <p className="replay-insights-loading muted">
            <Icon name="refresh" size={15} className="spin" />
            <span>{t(analysisLoading
              ? "replays.insights.walking"
              : "replays.insights.reading")}</span>
          </p>
        )
    )
    : null;

  return (
    <div className="replay-preview-scrim" role="presentation" onClick={onClose}>
      <div
        className="replay-insights"
        role="dialog"
        aria-label={t("replays.insights.aria", { name: title })}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="replay-insights-head">
          <div className="replay-insights-heading">
            <span className="replay-insights-kicker">{t("replays.insights.kicker")}</span>
            <h2 title={title}>{title}</h2>
          </div>
          <button
            type="button"
            className="replay-card-icon-btn"
            aria-label={t("replays.insights.close")}
            title={t("replays.insights.close")}
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </header>

        <SectionTabs
          active={tab}
          ariaLabel={t("replays.insights.tabsAria")}
          items={tabs}
          onChange={setTab}
          idPrefix={tabsId}
        />

        <div className="replay-insights-body" {...sectionPanelProps(tabsId, tab)}>
          {/* One state for the whole panel while the file is on its way: the
              tabs are already there to be read, and putting the same spinner
              in each of them would say four different things are loading. */}
          {!details && (
            error
              ? failure(error)
              : (
                <p className="replay-insights-loading muted">
                  <Icon name="refresh" size={15} className="spin" />
                  <span>{t(loading ? "replays.insights.reading" : "replays.detail.loadingDetails")}</span>
                </p>
              )
          )}

          {analysisNotice}

          {/* On every tab: a desynced replay shows one client's game from
              that moment on, which is worth knowing before reading anything
              after it. */}
          {analysis?.desyncTick != null && (
            <StatusNotice tone="info" className="replay-insights-desync">
              {t("replays.insights.desynced", { time: formatGameTime(analysis.desyncTick) })}
            </StatusNotice>
          )}

          {analysis && tab === "buildOrder" && <ReplayBuildOrderPane analysis={analysis} />}
          {analysis && tab === "events" && <ReplayEventsPanel analysis={analysis} />}
          {analysis && tab === "graph" && <ReplayActivityChart analysis={analysis} />}
          {analysis && tab === "heatmap" && (
            <ReplayHeatmap analysis={analysis} mapPreviewUrl={mapPreviewUrl} mapAction={mapAction} />
          )}
          {analysis && tab === "stats" && <ReplayGameStats stats={analysis.stats} />}

          {/* The lineup and their rates. Drawn from the stream once it is
              here, because that is where a player's colour, faction and own
              last action come from; from the cheap read until then, which
              knows the names and the counts. */}
          {analysis && tab === "players" && <ReplayPlayersPanel analysis={analysis} />}

          {!analysis && details && tab === "players" && <ReplayActivityPane rows={rows} />}

          {details && tab === "chat" && <ReplayChatPane chat={chat} />}

          {details && tab === "options" && (
            <ReplayOptionsPane filteredOptions={filteredOptions} optionFilter={optionFilter} setOptionFilter={setOptionFilter} />
          )}

          {details && tab === "mods" && (
            <ul className="replay-sim-mod-list">
              {/* Each one opens the mod vault on that mod (#343), the way a
                  lobby's mod list does. The replay names its mods, not their
                  vault ids, so the vault is searched by the name. */}
              {simMods.map((mod) => (
                <li key={mod}>
                  <button
                    type="button"
                    className="surface-chip replay-sim-mod"
                    title={t("lobby.details.openModInVault", { mod })}
                    onClick={() => openModInVault(mod)}
                  >
                    {mod}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
