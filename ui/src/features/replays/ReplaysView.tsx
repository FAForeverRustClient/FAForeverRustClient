// Replays workspace: backend state selects data; each tab owns its presentation state.
import { useEffect } from "react";
import { SectionTabs, sectionPanelProps } from "../../design-system/SectionTabs";
import type { ReplaysSection, ReplayStatus } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { LiveReplayView } from "./live/LiveReplayView";
import { LocalReplayView } from "./local/LocalReplayView";
import { OnlineReplayView } from "./online/OnlineReplayView";
import { subscribeReplaySearch } from "../../shared/replaySearchIntent";
import "./replays.css";
import { t, type MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

type SubView = ReplaysSection;

/**
 * The line above the tabs, for progress only.
 *
 * A failure used to be shown here too, as a strip of text at the very top of
 * the workspace. It was reported as being in the wrong place and it was: the
 * reader had just double-clicked a game halfway down the page and was looking
 * there, the strip pushed the whole tab down when it appeared, and the next
 * successful action wiped it with no way back to what it had said. The service
 * raises a notification instead, where the rest of this client's operational
 * messages already collect and where they stay until they are read.
 */
function statusNote(status: ReplayStatus): string | null {
  switch (status.type) {
    case "connecting":
      return t("replays.status.connecting");
    case "idle":
    case "playing":
    case "failed":
      return null;
  }
}

const SUB_VIEWS: Record<
  SubView,
  { label: MessageKey; Component: (props: { busy: boolean }) => JSX.Element }
> = {
  live: { label: "replays.source.live", Component: LiveReplayView },
  online: { label: "replays.source.online", Component: OnlineReplayView },
  local: { label: "replays.source.local", Component: LocalReplayView },
};

/**
 * The source is the backend's, like the Play tab's mode, so it survives the
 * workspace unmounting when another tab is chosen: coming back to Replays
 * lands on the source that was left, not on Online every time.
 */
const selectSubView = (section: SubView) =>
  ipc.send({ kind: "Nav", command: { type: "selectReplaysSection", payload: { section } } });

// Every "Replays" button elsewhere in the client (a profile, a leaderboard
// row, a matchmaker result) asks for a vault search, and the vault is the
// Online tab. Listened for here, at module level, and not in the component:
// the request is made *before* the button navigates, so a workspace that is
// not mounted yet would miss it and open on whichever source was remembered,
// Live or Local, where the search sits unread (issue 351). The module not
// being loaded yet is no gap: until it has been, nothing can have moved the
// remembered source off Online.
subscribeReplaySearch(() => {
  if (useAppStore.getState().state.nav.replaysSection !== "online") selectSubView("online");
});

export function ReplaysView() {
  const { t: translate } = useTranslation();
  const subView = useAppStore((state) => state.state.nav.replaysSection);
  // An offline session has the archive on this disk and nothing else: the
  // vault and the live games are both server questions.
  const offline = useAppStore((state) => state.state.auth.mode === "offline");
  const status = useAppStore((state) => state.state.replays.status);
  const lastWarning = useAppStore((state) => state.state.replays.lastWarning);
  // A campaign mission has no vault map, so without the mission catalogue every
  // co-op replay here reads as an unknown map. Only when nothing has loaded it
  // yet: the Play tab asks for the same list, and the service refuses a second
  // crawl anyway.
  useEffect(() => {
    if (offline) return;
    ipc.send({ kind: "Coop", command: { type: "loadCatalog" } });
  }, [offline]);

  const note = statusNote(status);
  const busy = status.type === "connecting";
  const sources: SubView[] = offline ? ["local"] : (Object.keys(SUB_VIEWS) as SubView[]);
  const activeSource = sources.includes(subView) ? subView : sources[0];
  const { Component } = SUB_VIEWS[activeSource];

  return (
    <div className="replays-workspace">
      {note && <div className="vault-note muted">{note}</div>}
      {status.type === "playing" && lastWarning && (
        <p className="replay-warning">
          {translate("replays.status.launchedWarning", { warning: lastWarning })}
        </p>
      )}
      <SectionTabs
        active={activeSource}
        ariaLabel={translate("replays.source.aria")}
        className="replay-source-tabs"
        items={sources.map((key) => ({ id: key, label: translate(SUB_VIEWS[key].label) }))}
        onChange={selectSubView}
        idPrefix="replay-source"
      />
      <div {...sectionPanelProps("replay-source", activeSource)}>
        <Component busy={busy} />
      </div>
    </div>
  );
}
