import { Icon } from "../../design-system/Icon";

export type ReplayViewMode = "tiles" | "list";
export const DEFAULT_REPLAY_VIEW: ReplayViewMode = "tiles";

export function ReplayViewSwitch({
  value,
  onChange,
}: {
  value: ReplayViewMode;
  onChange: (mode: ReplayViewMode) => void;
}) {
  return (
    <div className="replay-view-switch" role="group" aria-label="Replay view">
      <button
        type="button"
        className={value === "tiles" ? "active" : ""}
        aria-label="Tile view"
        aria-pressed={value === "tiles"}
        title="Tile view"
        onClick={() => onChange("tiles")}
      >
        <Icon name="grid" size={16} />
      </button>
      <button
        type="button"
        className={value === "list" ? "active" : ""}
        aria-label="List view"
        aria-pressed={value === "list"}
        title="List view"
        onClick={() => onChange("list")}
      >
        <Icon name="list" size={16} />
      </button>
    </div>
  );
}
