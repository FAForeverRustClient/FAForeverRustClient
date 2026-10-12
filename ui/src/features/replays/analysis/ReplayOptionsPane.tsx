import type { ReplayDetails } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { gameOptionLabel } from "./gameOptionLabels";

export function ReplayOptionsPane({ filteredOptions, optionFilter, setOptionFilter }: {
  filteredOptions: ReplayDetails["gameOptions"];
  optionFilter: string;
  setOptionFilter: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="replay-insights-toolbar">
        <input
          type="search"
          className="vault-input replay-options-filter"
          placeholder={t("replays.detail.filterOptions")}
          value={optionFilter}
          onChange={(event) => setOptionFilter(event.target.value)}
        />
      </div>
      <div className="replay-table-scroll">
        <table className="replay-data-table replay-options-table">
          <thead>
            <tr>
              <th>{t("replays.detail.optionName")}</th>
              <th>{t("replays.detail.optionValue")}</th>
            </tr>
          </thead>
          <tbody>
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => (
                <tr key={option.key}>
                  <td title={option.key}><strong>{gameOptionLabel(option.key)}</strong></td>
                  <td>{option.value}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={2} className="replay-table-empty muted">
                  {t("replays.detail.noOptionsMatch")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
