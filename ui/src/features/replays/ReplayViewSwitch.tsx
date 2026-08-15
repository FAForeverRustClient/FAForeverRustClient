import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";

export type ReplayViewMode = "tiles" | "list";
export const DEFAULT_REPLAY_VIEW: ReplayViewMode = "tiles";

export function ReplayViewSwitch({
  value,
  onChange,
}: {
  value: ReplayViewMode;
  onChange: (mode: ReplayViewMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="replay-view-switch" role="group" aria-label={t("replays.view.aria")}>
      <button
        type="button"
        className={value === "tiles" ? "active" : ""}
        aria-label={t("replays.view.tile")}
        aria-pressed={value === "tiles"}
        title={t("replays.view.tile")}
        onClick={() => onChange("tiles")}
      >
        <Icon name="grid" size={16} />
      </button>
      <button
        type="button"
        className={value === "list" ? "active" : ""}
        aria-label={t("replays.view.list")}
        aria-pressed={value === "list"}
        title={t("replays.view.list")}
        onClick={() => onChange("list")}
      >
        <Icon name="list" size={16} />
      </button>
    </div>
  );
}
