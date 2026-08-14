// Replays workspace: backend state selects data; each tab owns its presentation state.
import { useState } from "react";
import { SectionTabs } from "../../design-system/SectionTabs";
import type { ReplayStatus } from "../../ipc/bindings";
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
  const status = useAppStore((state) => state.state.replays.status);
  const lastWarning = useAppStore((state) => state.state.replays.lastWarning);
  const note = statusNote(status);
  const busy = status.type === "connecting";
  const { Component } = SUB_VIEWS[subView];

  return (
    <div className="replays-workspace">
      {note && <div className="vault-note muted">{note}</div>}
      {status.type === "playing" && lastWarning && (
        <p className="replay-warning">
          {translate("replays.status.launchedWarning", { warning: lastWarning })}
        </p>
      )}
      <SectionTabs
        active={subView}
        ariaLabel={translate("replays.source.aria")}
        className="replay-source-tabs"
        items={(Object.keys(SUB_VIEWS) as SubView[]).map((key) => ({ id: key, label: translate(SUB_VIEWS[key].label) }))}
        onChange={setSubView}
      />
      <Component busy={busy} />
    </div>
  );
}
