// The Changelog tab's unit history: pick a unit, and see what each game
// release changed about it, as a table and as a graph of one value.
//
// The same two surfaces as the patch notes beside it: a list on the left and
// a reading surface on the right. Every value comes from the unit's
// blueprints as each release had them (see faf-domain's
// `protocol::unit_history`); a row and a step in the graph open that
// release's patch note in the Game section, which is where the reason for a
// change is written down.

import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { Icon } from "../../design-system/Icon";
import { Select } from "../../design-system/Select";
import { StatusNotice } from "../../design-system/StatusNotice";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import { useRememberedFilter } from "../../shared/filterMemory";
import { plainError } from "../../shared/plainError";
import { formatDate } from "../../shared/format/dates";
import type { UnitChange, UnitHistory, UnitRelease, UnitValueKey } from "../../ipc/bindings";
import { UnitHistoryChart } from "./UnitHistoryChart";
import {
  alignedValues,
  comparableKey,
  defaultKey,
  drawableKeys,
  filterUnits,
  formatValue,
  UNIT_FACTIONS,
  unitTitle,
  valueKeyId,
  valueLabel,
} from "./unitHistory";

type Translate = ReturnType<typeof useTranslation>["t"];

const selectUnit = (id: string) => ipc.send({ kind: "UnitHistory", command: { type: "select", payload: { id } } });
const compareUnit = (id: string | null) =>
  ipc.send({ kind: "UnitHistory", command: { type: "compare", payload: { id } } });

export function UnitHistoryView({ onOpenRelease }: { onOpenRelease: (id: string) => void }) {
  const { t } = useTranslation();
  const units = useAppStore((state) => state.state.unitHistory.units);
  const listStatus = useAppStore((state) => state.state.unitHistory.listStatus);
  const selected = useAppStore((state) => state.state.unitHistory.selected);
  const compared = useAppStore((state) => state.state.unitHistory.compared);
  const histories = useAppStore((state) => state.state.unitHistory.histories);
  const [search, setSearch] = useRememberedFilter("changelog.units.search", "", (value) => typeof value === "string");
  const [faction, setFaction] = useRememberedFilter("changelog.units.faction", "", (value) => typeof value === "string");
  const [tech, setTech] = useRememberedFilter<number | null>(
    "changelog.units.tech",
    null,
    (value) => value === null || typeof value === "number",
  );

  useEffect(() => {
    ipc.send({ kind: "UnitHistory", command: { type: "loadList" } });
  }, []);

  const shown = useMemo(() => filterUnits(units, search, faction, tech), [units, search, faction, tech]);

  if (listStatus.type === "failed" && units.length === 0) {
    return (
      <div className="changelog-view">
        <EmptyState
          icon="units"
          title={t("changelog.units.listFailed")}
          hint={<span title={listStatus.payload.reason}>{plainError(listStatus.payload.reason)}</span>}
        >
          <Button variant="primary" onClick={() => ipc.send({ kind: "UnitHistory", command: { type: "loadList" } })}>
            {t("changelog.retry")}
          </Button>
        </EmptyState>
      </div>
    );
  }

  const status = selected ? histories[selected] : undefined;
  const comparedStatus = compared ? histories[compared] : undefined;

  return (
    <div className="changelog-view">
      <aside className="changelog-sidebar surface-panel">
        <div className="search-field changelog-search">
          <Icon name="search" size={13} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("changelog.units.searchPlaceholder")}
            aria-label={t("changelog.units.searchAria")}
          />
        </div>
        <div className="unit-history-filters">
          <Select<string>
            value={faction}
            onChange={setFaction}
            label={t("changelog.units.faction")}
            options={[
              { value: "", label: t("changelog.units.anyFaction") },
              ...UNIT_FACTIONS.map((name) => ({ value: name, label: name })),
            ]}
          />
          <Select<number>
            value={tech ?? 0}
            onChange={(value) => setTech(value === 0 ? null : value)}
            label={t("changelog.units.tech")}
            options={[
              { value: 0, label: t("changelog.units.anyTech") },
              { value: 1, label: t("changelog.units.techLevel", { level: 1 }) },
              { value: 2, label: t("changelog.units.techLevel", { level: 2 }) },
              { value: 3, label: t("changelog.units.techLevel", { level: 3 }) },
              { value: 4, label: t("changelog.units.experimental") },
            ]}
          />
        </div>
        <nav className="changelog-releases" aria-label={t("changelog.units.list")}>
          {listStatus.type === "loading" && units.length === 0 && (
            <p className="changelog-list-note">{t("changelog.units.listLoading")}</p>
          )}
          {listStatus.type === "ready" && shown.length === 0 && (
            <p className="changelog-list-note">{t("changelog.units.noMatch")}</p>
          )}
          <ul className="unit-history-units">
            {shown.map((unit) => (
              <li key={unit.id}>
                <button
                  type="button"
                  className="unit-history-unit"
                  aria-current={unit.id === selected ? "page" : undefined}
                  onClick={() => selectUnit(unit.id)}
                >
                  <span className="unit-history-unit-name">{unitTitle(unit)}</span>
                  <span className="unit-history-unit-meta">
                    {[unit.name ? unit.description : null, unit.id].filter(Boolean).join(" · ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <article className="changelog-note surface-panel" aria-busy={status?.type === "loading" || undefined}>
        {!selected && <p className="changelog-list-note unit-history-pick">{t("changelog.units.pick")}</p>}
        {selected && status?.type === "loading" && (
          <div className="unit-history-progress">
            <p>{t("changelog.units.loading", { fetched: status.payload.fetched, total: status.payload.total })}</p>
            <progress max={Math.max(1, status.payload.total)} value={status.payload.fetched} />
            <p className="muted">{t("changelog.units.loadingHint")}</p>
          </div>
        )}
        {selected && status?.type === "failed" && (
          <div className="unit-history-progress">
            <StatusNotice
              tone="error"
              action={{ label: t("changelog.retry"), onClick: () => selectUnit(selected) }}
              detail={status.payload.reason}
            >
              {plainError(status.payload.reason)}
            </StatusNotice>
          </div>
        )}
        {status?.type === "ready" && (
          <UnitHistoryDetail
            history={status.payload.history}
            compared={comparedStatus?.type === "ready" ? comparedStatus.payload.history : null}
            comparedLoading={comparedStatus?.type === "loading"}
            comparedFailed={comparedStatus?.type === "failed" ? comparedStatus.payload.reason : null}
            comparedId={compared}
            onOpenRelease={onOpenRelease}
          />
        )}
      </article>
    </div>
  );
}

interface DetailProps {
  history: UnitHistory;
  compared: UnitHistory | null;
  comparedLoading: boolean;
  comparedFailed: string | null;
  comparedId: string | null;
  onOpenRelease: (id: string) => void;
}

function UnitHistoryDetail({ history, compared, comparedLoading, comparedFailed, comparedId, onOpenRelease }: DetailProps) {
  const { t } = useTranslation();
  const units = useAppStore((state) => state.state.unitHistory.units);
  const keys = useMemo(() => drawableKeys(history), [history]);
  const [chosen, setChosen] = useState<string | null>(null);
  const key: UnitValueKey | null =
    keys.find((candidate) => valueKeyId(candidate) === chosen) ?? defaultKey(history);
  const releaseIds = useMemo(() => history.releases.map((release) => release.release), [history]);
  const unit = history.unit;

  const otherKey = compared && key ? comparableKey(compared, key) : null;
  // The compared unit's weapon is named when it is a different one.
  const otherLabel =
    compared && otherKey
      ? otherKey.type === "weapon" && key?.type === "weapon" && otherKey.payload.weapon !== key.payload.weapon
        ? `${unitTitle(compared.unit)}: ${compared.weapons.find((weapon) => weapon.key === otherKey.payload.weapon)?.name ?? otherKey.payload.weapon}`
        : unitTitle(compared.unit)
      : "";
  const series = key
    ? [
        { label: unitTitle(unit), values: alignedValues(history, key, releaseIds) },
        ...(compared && otherKey
          ? [{ label: otherLabel, values: alignedValues(compared, otherKey, releaseIds), compared: true }]
          : []),
      ]
    : [];
  const comparedLacksValue = Boolean(compared && key && !otherKey);

  return (
    <>
      <header className="changelog-note-head">
        <div className="changelog-note-heading">
          <h1>{unitTitle(unit)}</h1>
          <p className="changelog-note-meta">
            {[unit.name ? unit.description : null, unit.faction, unit.tech === 4 ? t("changelog.units.experimental") : unit.tech ? t("changelog.units.techLevel", { level: unit.tech }) : null, unit.id]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </header>
      <div className="changelog-note-scroll">
        <div className="unit-history-body">
          <section className="unit-history-graph" aria-label={t("changelog.units.chart.title")}>
            <div className="unit-history-controls">
              <Select<string>
                value={key ? valueKeyId(key) : ""}
                onChange={setChosen}
                label={t("changelog.units.value")}
                options={keys.map((candidate) => ({ value: valueKeyId(candidate), label: valueLabel(candidate, history, t) }))}
              />
              <Select<string>
                value={comparedId ?? ""}
                onChange={(id) => compareUnit(id === "" ? null : id)}
                label={t("changelog.units.compare")}
                options={[
                  { value: "", label: t("changelog.units.compareNone") },
                  ...units
                    .filter((other) => other.id !== unit.id)
                    .map((other) => ({ value: other.id, label: `${unitTitle(other)} (${other.id})` })),
                ]}
              />
            </div>
            {comparedLoading && <p className="muted">{t("changelog.units.compareLoading")}</p>}
            {comparedFailed && <p className="muted" title={comparedFailed}>{plainError(comparedFailed)}</p>}
            {comparedLacksValue && <p className="muted">{t("changelog.units.compareLacksValue")}</p>}
            {key && (
              <UnitHistoryChart
                releases={history.releases.map((release) => ({ id: release.release, date: release.date }))}
                series={series}
                format={(value) => formatValue(key, value)}
                onOpenRelease={onOpenRelease}
              />
            )}
          </section>

          <section className="unit-history-changes" aria-label={t("changelog.units.changes")}>
            <h2>{t("changelog.units.changes")}</h2>
            {history.changes.length === 0 ? (
              <p className="muted">{t("changelog.units.noChanges")}</p>
            ) : (
              <table className="unit-history-table">
                <thead>
                  <tr>
                    <th scope="col">{t("changelog.units.release")}</th>
                    <th scope="col">{t("changelog.units.changed")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...history.changes].reverse().map((row) => (
                    <tr key={row.release}>
                      <th scope="row">
                        <button type="button" className="unit-history-release" onClick={() => onOpenRelease(row.release)}>
                          {row.release}
                        </button>
                        {row.date && (
                          <time dateTime={row.date}>{formatDate(row.date, "", { day: "numeric", month: "short", year: "numeric" })}</time>
                        )}
                        <SourceTag release={history.releases.find((release) => release.release === row.release)} t={t} />
                      </th>
                      <td>
                        <ul className="unit-history-change-list">
                          {row.changes.map((change, index) => (
                            <li key={index}>
                              <ChangeLine change={change} history={history} t={t} />
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <UnavailableReleases releases={history.releases} t={t} />
          </section>

          <p className="unit-history-limits muted">{t("changelog.units.limits")}</p>
        </div>
      </div>
    </>
  );
}

function SourceTag({ release, t }: { release: UnitRelease | undefined; t: Translate }) {
  if (release?.source.type !== "baseGame") return null;
  return <span className="unit-history-source">{t("changelog.units.baseGame")}</span>;
}

function ChangeLine({ change, history, t }: { change: UnitChange; history: UnitHistory; t: Translate }) {
  switch (change.type) {
    case "added":
      return <span className="unit-history-added">{t("changelog.units.added")}</span>;
    case "removed":
      return <span className="unit-history-removed">{t("changelog.units.removed")}</span>;
    case "categories":
      return (
        <span>
          <span className="muted">{t("changelog.units.categories")}</span>{" "}
          {change.payload.added.map((category) => (
            <code key={`+${category}`} className="unit-history-added">+{category}</code>
          ))}
          {change.payload.removed.map((category) => (
            <code key={`-${category}`} className="unit-history-removed">{"−"}{category}</code>
          ))}
        </span>
      );
    case "value": {
      // No green or red for up and down: more health is a buff and more cost
      // a nerf, so the direction alone says nothing about which it was.
      const { key, before, after } = change.payload;
      return (
        <span>
          <span className="muted">{valueLabel(key, history, t)}</span>{" "}
          <span className="unit-history-old">{formatValue(key, before)}</span>
          {" → "}
          <span className="unit-history-new">{formatValue(key, after)}</span>
        </span>
      );
    }
  }
}

/** Releases whose values could not be found out, named so a gap is explained. */
function UnavailableReleases({ releases, t }: { releases: UnitRelease[]; t: Translate }) {
  const unavailable = releases.filter((release) => release.source.type === "unavailable");
  if (unavailable.length === 0) return null;
  const first = unavailable[0].source;
  const reason = first.type === "unavailable" ? first.payload.reason : "";
  return (
    <p className="muted" title={reason}>
      {t("changelog.units.unavailable", { count: unavailable.length, releases: unavailable.map((release) => release.release).join(", ") })}
    </p>
  );
}
