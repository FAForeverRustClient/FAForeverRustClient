// Replays workspace: backend state selects data; each tab owns its presentation state.
import { useEffect, useState } from "react";
import { SectionTabs } from "../../design-system/SectionTabs";
import type { ReplayStatus } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { LiveReplayView } from "./LiveReplayView";
import { LocalReplayView } from "./LocalReplayView";
import { OnlineReplayView } from "./OnlineReplayView";
import "./replays.css";
import { t, type MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

type SubView = "live" | "online" | "local";

function statusNote(status: ReplayStatus): string | null {
  switch (status.type) {
    case "idle":
      return null;
    case "connecting":
      return t("replays.status.connecting");
    case "playing":
      return null;
    case "failed":
      return t("replays.status.failed", { reason: status.payload.reason });
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

export function ReplaysView() {
  const { t: translate } = useTranslation();
  const [subView, setSubView] = useState<SubView>("online");
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
    if (useAppStore.getState().state.coop.catalogStatus.type === "idle") {
      ipc.send({ kind: "Coop", command: { type: "loadCatalog" } });
    }
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
        onChange={setSubView}
      />
      <Component busy={busy} />
    </div>
  );
}
