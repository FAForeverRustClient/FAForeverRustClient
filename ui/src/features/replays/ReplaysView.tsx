// Replays workspace: backend state selects data; each tab owns its presentation state.
import { useState } from "react";
import { SectionTabs } from "../../design-system/SectionTabs";
import type { ReplayStatus } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { LiveReplayView } from "./LiveReplayView";
import { LocalReplayView } from "./LocalReplayView";
import { OnlineReplayView } from "./OnlineReplayView";
import "./replays.css";

type SubView = "live" | "online" | "local";

function statusNote(status: ReplayStatus): string | null {
  switch (status.type) {
    case "idle":
      return null;
    case "connecting":
      return "Connecting to the replay…";
    case "playing":
      return null;
    case "failed":
      return `Replay failed: ${status.payload.reason}`;
  }
}

const SUB_VIEWS: Record<
  SubView,
  { label: string; Component: (props: { busy: boolean }) => JSX.Element }
> = {
  live: { label: "Live", Component: LiveReplayView },
  online: { label: "Online", Component: OnlineReplayView },
  local: { label: "Local", Component: LocalReplayView },
};

export function ReplaysView() {
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
          Launched, but: {lastWarning}. FA may get stuck loading if this doesn't resolve itself.
        </p>
      )}
      <SectionTabs
        active={subView}
        ariaLabel="Replay sources"
        className="replay-source-tabs"
        items={(Object.keys(SUB_VIEWS) as SubView[]).map((key) => ({ id: key, label: SUB_VIEWS[key].label }))}
        onChange={setSubView}
      />
      <Component busy={busy} />
    </div>
  );
}
