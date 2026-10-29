// The Changelog tab's unit history, laid out like a unit database: every unit
// as its build icon, by faction and tech level, and the units picked from it
// compared across the game releases.
//
// One unit picked shows all of its values that ever changed in one chart, as
// percentages of where they started, since a health of 3000 and a speed of 3.4
// share no other axis. Several units picked are compared one value at a time,
// in the value's own numbers. Under the chart, every release that changed one
// of them, with the old and the new value the way the patch notes print a
// balance change. A release opens its patch notes in the Game section, which
// is where the reason for a change is written down.
//
// Every value comes from the units' blueprints as each release had them (see
// faf-domain's `protocol::unit_history`).

import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { Icon } from "../../design-system/Icon";
import { Select } from "../../design-system/Select";
import { StatusNotice } from "../../design-system/StatusNotice";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { MAX_SELECTED_UNITS } from "../../store/reducers/unitHistory";
import { useTranslation } from "../../i18n/useTranslation";
import { formatNumber } from "../../i18n";
import { useRememberedFilter } from "../../shared/filterMemory";
import { plainError } from "../../shared/plainError";
import { formatDate } from "../../shared/format/dates";
import type { UnitChange, UnitChangeRow, UnitHistory, UnitRelease, UnitSummary, UnitValueKey } from "../../ipc/bindings";
import { UnitHistoryChart, type ChartSeries } from "./UnitHistoryChart";
import {
  alignedValues,
  CHART_COLORS,
  changedKeys,
  comparableKey,
  defaultKey,
  defaultStatKeys,
  drawableKeys,
  filterUnits,
  formatPercentChange,
  formatValue,
  groupUnits,
  indexedValues,
  releaseOrder,
  UNIT_FACTIONS,
  unitTitle,
  valueKeyId,
  valueLabel,
} from "./unitHistory";
import "../../shared/components/changelog-blocks.css";

type Translate = ReturnType<typeof useTranslation>["t"];

const setSelection = (ids: string[]) =>
  ipc.send({ kind: "UnitHistory", command: { type: "setSelection", payload: { ids } } });

/** A unit's colour in the chart and around its icon: its place in the selection. */
const selectionColor = (index: number) => (index % CHART_COLORS) + 1;

function techLabel(tech: number | null, t: Translate): string {
  if (tech === 4) return t("changelog.units.experimental");
  if (tech) return t("changelog.units.techShort", { level: tech });
  return t("changelog.units.techOther");
}

export function UnitHistoryView({ onOpenRelease }: { onOpenRelease: (id: string) => void }) {
  const { t } = useTranslation();
  const units = useAppStore((state) => state.state.unitHistory.units);
  const listStatus = useAppStore((state) => state.state.unitHistory.listStatus);
  const selected = useAppStore((state) => state.state.unitHistory.selected);
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

  const groups = useMemo(() => groupUnits(filterUnits(units, search, faction, tech)), [units, search, faction, tech]);
  const full = selected.length >= MAX_SELECTED_UNITS;

  const toggle = (id: string) => {
    if (selected.includes(id)) setSelection(selected.filter((other) => other !== id));
    else if (!full) setSelection([...selected, id]);
  };

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

  const ready = selected
    .map((id) => histories[id])
    .flatMap((status) => (status?.type === "ready" ? [status.payload.history] : []));

  return (
    <div className="changelog-view unit-history-view">
      <aside className="changelog-sidebar surface-panel unit-history-picker">
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
        <div className="changelog-releases unit-history-grid-scroll" aria-label={t("changelog.units.list")}>
          {listStatus.type === "loading" && units.length === 0 && (
            <p className="changelog-list-note">{t("changelog.units.listLoading")}</p>
          )}
          {listStatus.type === "ready" && groups.length === 0 && (
            <p className="changelog-list-note">{t("changelog.units.noMatch")}</p>
          )}
          {groups.map((group) => (
            <section key={group.faction} className="unit-history-faction">
              <h3>{group.faction}</h3>
              {group.tiers.map((tier) => (
                <div key={String(tier.tech)} className="unit-history-tier">
                  <span className="unit-history-tier-label">{techLabel(tier.tech, t)}</span>
                  <div className="unit-history-icons">
                    {tier.units.map((unit) => {
                      const index = selected.indexOf(unit.id);
                      return (
                        <UnitIconButton
                          key={unit.id}
                          unit={unit}
                          color={index === -1 ? null : selectionColor(index)}
                          disabled={index === -1 && full}
                          onClick={() => toggle(unit.id)}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      </aside>

      <article className="changelog-note surface-panel" aria-busy={selected.some((id) => histories[id]?.type === "loading") || undefined}>
        <header className="changelog-note-head unit-history-head">
          {selected.length === 0 ? (
            <p className="changelog-list-note unit-history-pick">{t("changelog.units.pick")}</p>
          ) : (
            <ul className="unit-history-chips" aria-label={t("changelog.units.selected")}>
              {selected.map((id, index) => {
                const unit = units.find((candidate) => candidate.id === id);
                return (
                  <li key={id} className="unit-history-chip" style={{ borderColor: `var(--color-chart-${selectionColor(index)})` }}>
                    {unit && <img src={unit.iconUrl} alt="" width={24} height={24} loading="lazy" draggable={false} />}
                    <span>{unit ? unitTitle(unit) : id}</span>
                    <button
                      type="button"
                      className="unit-history-chip-remove"
                      aria-label={t("changelog.units.remove", { name: unit ? unitTitle(unit) : id })}
                      onClick={() => toggle(id)}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </li>
                );
              })}
              {selected.length > 1 && (
                <li>
                  <Button onClick={() => setSelection([])}>{t("changelog.units.clear")}</Button>
                </li>
              )}
            </ul>
          )}
          {full && <p className="muted unit-history-full">{t("changelog.units.full", { count: MAX_SELECTED_UNITS })}</p>}
        </header>

        <div className="changelog-note-scroll">
          <div className="unit-history-body">
            {selected.map((id) => {
              const status = histories[id];
              const unit = units.find((candidate) => candidate.id === id);
              const name = unit ? unitTitle(unit) : id;
              if (status?.type === "loading") {
                return (
                  <div key={id} className="unit-history-progress">
                    <p>{t("changelog.units.loading", { name, fetched: status.payload.fetched, total: status.payload.total })}</p>
                    <progress max={Math.max(1, status.payload.total)} value={status.payload.fetched} />
                  </div>
                );
              }
              if (status?.type === "failed") {
                return (
                  <StatusNotice
                    key={id}
                    tone="error"
                    action={{ label: t("changelog.retry"), onClick: () => setSelection([...selected]) }}
                    detail={status.payload.reason}
                  >
                    {`${name}: ${plainError(status.payload.reason)}`}
                  </StatusNotice>
                );
              }
              return null;
            })}
            {selected.some((id) => histories[id]?.type === "loading") && (
              <p className="muted">{t("changelog.units.loadingHint")}</p>
            )}

            {ready.length === 1 && selected.length === 1 && (
              <SingleUnitChart key={ready[0].unit.id} history={ready[0]} onOpenRelease={onOpenRelease} />
            )}
            {ready.length > 1 && <CompareChart histories={ready} selected={selected} onOpenRelease={onOpenRelease} />}
            {ready.length > 0 && <ChangeList histories={ready} onOpenRelease={onOpenRelease} />}
            {ready.length > 0 && <p className="unit-history-limits muted">{t("changelog.units.limits")}</p>}
          </div>
        </div>
      </article>
    </div>
  );
}

function UnitIconButton({
  unit,
  color,
  disabled,
  onClick,
}: {
  unit: UnitSummary;
  color: number | null;
  disabled: boolean;
  onClick: () => void;
}) {
  const [missing, setMissing] = useState(false);
  const label = [unitTitle(unit), unit.name ? unit.description : null, unit.id].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className={`unit-history-icon${color !== null ? " is-selected" : ""}`}
      style={color !== null ? { outlineColor: `var(--color-chart-${color})` } : undefined}
      aria-pressed={color !== null}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {missing ? (
        <span className="unit-history-icon-id">{unit.id}</span>
      ) : (
        <img src={unit.iconUrl} alt="" width={40} height={40} loading="lazy" draggable={false} onError={() => setMissing(true)} />
      )}
    </button>
  );
}

interface ActiveValue {
  id: string;
  color: number;
}

/** One unit: every value that changed, as a percentage of where it started. */
function SingleUnitChart({ history, onOpenRelease }: { history: UnitHistory; onOpenRelease: (id: string) => void }) {
  const { t } = useTranslation();
  const changed = useMemo(() => changedKeys(history), [history]);
  // A value keeps its colour while it is shown: colours follow the value,
  // not its place in the list, and are given out lowest free first.
  const [active, setActive] = useState<ActiveValue[]>(() =>
    defaultStatKeys(history).map((key, index) => ({ id: valueKeyId(key), color: index + 1 })),
  );
  const releases = history.releases.map((release) => ({ id: release.release, date: release.date }));
  const releaseIds = releases.map((release) => release.id);

  if (changed.length === 0) {
    return <p className="muted">{t("changelog.units.noChangedValues")}</p>;
  }

  const toggle = (id: string) => {
    setActive((current) => {
      if (current.some((value) => value.id === id)) return current.filter((value) => value.id !== id);
      if (current.length >= CHART_COLORS) return current;
      const used = new Set(current.map((value) => value.color));
      const color = Array.from({ length: CHART_COLORS }, (_, index) => index + 1).find((candidate) => !used.has(candidate)) ?? 1;
      return [...current, { id, color }];
    });
  };

  const series: ChartSeries[] = active.flatMap(({ id, color }) => {
    const key = changed.find((candidate) => valueKeyId(candidate) === id);
    if (!key) return [];
    const raw = alignedValues(history, key, releaseIds);
    const indexed = indexedValues(raw);
    return [
      {
        key: id,
        label: valueLabel(key, history, t),
        values: indexed,
        color,
        describe: (index: number) => `${formatValue(key, raw[index] ?? null)} (${formatPercentChange(indexed[index] ?? null)})`,
      },
    ];
  });

  return (
    <section className="unit-history-graph" aria-label={t("changelog.units.chart.title")}>
      <ul className="unit-history-legend" aria-label={t("changelog.units.chart.values")}>
        {changed.map((key) => {
          const id = valueKeyId(key);
          const shown = active.find((value) => value.id === id);
          return (
            <li key={id}>
              <button
                type="button"
                className={`unit-history-legend-item${shown ? " is-active" : ""}`}
                aria-pressed={Boolean(shown)}
                disabled={!shown && active.length >= CHART_COLORS}
                onClick={() => toggle(id)}
              >
                <span
                  className="unit-history-swatch"
                  style={shown ? { background: `var(--color-chart-${shown.color})` } : undefined}
                />
                {valueLabel(key, history, t)}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="unit-history-axis-caption muted">{t("changelog.units.chart.relative")}</p>
      <UnitHistoryChart
        releases={releases}
        series={series}
        format={(value) => `${formatNumber(Math.round(value))}%`}
        floor={null}
        baseline={100}
        onOpenRelease={onOpenRelease}
      />
    </section>
  );
}

/** Several units: one value at a time, in its own numbers. */
function CompareChart({
  histories,
  selected,
  onOpenRelease,
}: {
  histories: UnitHistory[];
  selected: string[];
  onOpenRelease: (id: string) => void;
}) {
  const { t } = useTranslation();
  const first = histories[0];
  const keys = useMemo(() => drawableKeys(first), [first]);
  const [chosen, setChosen] = useState<string | null>(null);
  const key: UnitValueKey | null = keys.find((candidate) => valueKeyId(candidate) === chosen) ?? defaultKey(first);
  const releases = first.releases.map((release) => ({ id: release.release, date: release.date }));
  const releaseIds = releases.map((release) => release.id);

  const series: ChartSeries[] = key
    ? histories.flatMap((history) => {
        const own = comparableKey(history, key);
        if (!own) return [];
        const differentWeapon =
          own.type === "weapon" && key.type === "weapon" && own.payload.weapon !== key.payload.weapon;
        const weapon = own.type === "weapon" ? history.weapons.find((known) => known.key === own.payload.weapon) : undefined;
        return [
          {
            key: history.unit.id,
            label: differentWeapon ? `${unitTitle(history.unit)}: ${weapon?.name ?? own.payload.weapon}` : unitTitle(history.unit),
            values: alignedValues(history, own, releaseIds),
            color: selectionColor(selected.indexOf(history.unit.id)),
          },
        ];
      })
    : [];
  const lacking = key ? histories.filter((history) => !comparableKey(history, key)) : [];

  return (
    <section className="unit-history-graph" aria-label={t("changelog.units.chart.title")}>
      <div className="unit-history-controls">
        <Select<string>
          value={key ? valueKeyId(key) : ""}
          onChange={setChosen}
          label={t("changelog.units.value")}
          options={keys.map((candidate) => ({ value: valueKeyId(candidate), label: valueLabel(candidate, first, t) }))}
        />
      </div>
      <ul className="unit-history-legend" aria-label={t("changelog.units.chart.legend")}>
        {series.map((one) => (
          <li key={one.key} className="unit-history-legend-item is-active">
            <span className="unit-history-swatch" style={{ background: `var(--color-chart-${one.color})` }} />
            {one.label}
          </li>
        ))}
      </ul>
      {lacking.length > 0 && (
        <p className="muted">
          {t("changelog.units.lacksValue", { names: lacking.map((history) => unitTitle(history.unit)).join(", ") })}
        </p>
      )}
      {key && (
        <UnitHistoryChart
          releases={releases}
          series={series}
          format={(value) => formatValue(key, value)}
          floor={0}
          onOpenRelease={onOpenRelease}
        />
      )}
    </section>
  );
}

/** Every release that changed one of the units, newest first. */
function ChangeList({ histories, onOpenRelease }: { histories: UnitHistory[]; onOpenRelease: (id: string) => void }) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    const byRelease = new Map<string, { release: string; date: string; entries: Array<{ history: UnitHistory; row: UnitChangeRow }> }>();
    for (const history of histories) {
      for (const row of history.changes) {
        const entry = byRelease.get(row.release) ?? { release: row.release, date: row.date, entries: [] };
        entry.entries.push({ history, row });
        byRelease.set(row.release, entry);
      }
    }
    return [...byRelease.values()].sort((left, right) => releaseOrder(right.release) - releaseOrder(left.release));
  }, [histories]);
  const several = histories.length > 1;

  return (
    <section className="unit-history-changes" aria-label={t("changelog.units.changes")}>
      <h2>{t("changelog.units.changes")}</h2>
      {rows.length === 0 ? (
        <p className="muted">{t("changelog.units.noChanges")}</p>
      ) : (
        <ol className="unit-history-change-rows">
          {rows.map((row) => (
            <li key={row.release} className="unit-history-change-row">
              <div className="unit-history-change-release">
                <button type="button" className="unit-history-release" onClick={() => onOpenRelease(row.release)}>
                  {row.release}
                </button>
                {row.date && (
                  <time dateTime={row.date}>{formatDate(row.date, "", { day: "numeric", month: "short", year: "numeric" })}</time>
                )}
              </div>
              <div className="unit-history-change-units">
                {row.entries.map(({ history, row: changes }) => (
                  <div key={history.unit.id} className="unit-history-change-unit">
                    {several && (
                      <div className="changelog-unit unit-history-change-unit-head">
                        <img className="changelog-unit-icon" src={history.unit.iconUrl} alt="" loading="lazy" draggable={false} />
                        <span className="changelog-unit-name">{unitTitle(history.unit)}</span>
                      </div>
                    )}
                    <SourceTag release={history.releases.find((release) => release.release === row.release)} t={t} />
                    <ul className="changelog-list">
                      {changes.changes.map((change, index) => (
                        <li key={index}>
                          <ChangeLine change={change} history={history} t={t} />
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
      {histories.map((history) => (
        <UnavailableReleases key={history.unit.id} history={history} several={several} t={t} />
      ))}
    </section>
  );
}

function SourceTag({ release, t }: { release: UnitRelease | undefined; t: Translate }) {
  if (release?.source.type !== "baseGame") return null;
  return <span className="unit-history-source">{t("changelog.units.baseGame")}</span>;
}

/** A change the way the patch notes print one: the old value struck through
 * in red, an arrow, the new value in green. */
function ChangeLine({ change, history, t }: { change: UnitChange; history: UnitHistory; t: Translate }) {
  switch (change.type) {
    case "added":
      return <span className="changelog-new">{t("changelog.units.added")}</span>;
    case "removed":
      return <span className="changelog-old">{t("changelog.units.removed")}</span>;
    case "categories":
      return (
        <span className="changelog-change">
          <span className="changelog-change-label">{t("changelog.units.categories")}</span>
          {change.payload.removed.map((category) => (
            <span key={`-${category}`} className="changelog-old">{category}</span>
          ))}
          {change.payload.added.map((category) => (
            <span key={`+${category}`} className="changelog-new">{category}</span>
          ))}
        </span>
      );
    case "value": {
      const { key, before, after } = change.payload;
      return (
        <span className="changelog-change">
          <span className="changelog-change-label">{valueLabel(key, history, t)}</span>
          {before !== null && <span className="changelog-old">{formatValue(key, before)}</span>}
          {before !== null && after !== null && <Icon name="arrowRight" size={12} />}
          {after !== null && <span className="changelog-new">{formatValue(key, after)}</span>}
        </span>
      );
    }
  }
}

/** Releases whose values could not be found out, named so a gap is explained. */
function UnavailableReleases({ history, several, t }: { history: UnitHistory; several: boolean; t: Translate }) {
  const unavailable = history.releases.filter((release) => release.source.type === "unavailable");
  if (unavailable.length === 0) return null;
  const first = unavailable[0].source;
  const reason = first.type === "unavailable" ? first.payload.reason : "";
  const text = t("changelog.units.unavailable", {
    count: unavailable.length,
    releases: unavailable.map((release) => release.release).join(", "),
  });
  return (
    <p className="muted" title={reason}>
      {several ? `${unitTitle(history.unit)}: ${text}` : text}
    </p>
  );
}
