// The Changelog tab's unit history, laid out like a unit database: every unit
// as its build icon with its strategic icon in the corner, by faction and then
// land, air, naval and structures, and the units picked from it compared
// across the game releases.
//
// Values are ticked in a list. With one value ticked the chart shows it in its
// own numbers; with several, each line is a percentage of where it started,
// since a health of 3000 and a speed of 3.4 share no other axis (hovering a
// release shows the numbers themselves). One unit picked gives each value its
// own colour; several give each unit its colour and each value its own dash.
// Under the chart, every release that changed one of the units, with the old
// and the new value the way the patch notes print a balance change. A release
// opens its patch notes in the Game section.
//
// Every value comes from the units' blueprints as each release had them (see
// faf-domain's `protocol::unit_history`), the pictures from the installed
// game (`infra::unit_icons`).

import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { Icon } from "../../design-system/Icon";
import { Select } from "../../design-system/Select";
import { StatusNotice } from "../../design-system/StatusNotice";
import { ipc } from "../../ipc/client";
import { native, type UnitIcons } from "../../ipc/native";
import { useAppStore } from "../../store/store";
import { MAX_SELECTED_UNITS } from "../../store/reducers/unitHistory";
import { useTranslation } from "../../i18n/useTranslation";
import { formatNumber } from "../../i18n";
import { useRememberedFilter } from "../../shared/filterMemory";
import { plainError } from "../../shared/plainError";
import { formatDate } from "../../shared/format/dates";
import type { UnitChange, UnitChangeRow, UnitHistory, UnitRelease, UnitSummary, UnitValueKey } from "../../ipc/bindings";
import { LineSample, UnitHistoryChart, type ChartSeries } from "./UnitHistoryChart";
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
  UNIT_KIND_LABELS,
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

/** The dashes that tell several values of one unit apart, in order. */
const DASHES = ["", "7 4", "2 3", "10 3 2 3"];

/** The game's pictures, asked for once per session and shared by every tile. */
let iconsRequest: Promise<UnitIcons | null> | null = null;

function useUnitIcons(): UnitIcons | null {
  const [icons, setIcons] = useState<UnitIcons | null>(null);
  useEffect(() => {
    let current = true;
    iconsRequest ??= native.readUnitIcons().catch(() => null);
    void iconsRequest.then((loaded) => {
      if (current) setIcons(loaded);
    });
    return () => {
      current = false;
    };
  }, []);
  return icons;
}

export function UnitHistoryView({ onOpenRelease }: { onOpenRelease: (id: string) => void }) {
  const { t } = useTranslation();
  const units = useAppStore((state) => state.state.unitHistory.units);
  const listStatus = useAppStore((state) => state.state.unitHistory.listStatus);
  const selected = useAppStore((state) => state.state.unitHistory.selected);
  const histories = useAppStore((state) => state.state.unitHistory.histories);
  const icons = useUnitIcons();
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
              {group.kinds.map((kind) => (
                <div key={kind.kind} className="unit-history-kind">
                  <span className="unit-history-kind-label">{t(UNIT_KIND_LABELS[kind.kind])}</span>
                  <div className="unit-history-icons">
                    {kind.units.map((unit) => {
                      const index = selected.indexOf(unit.id);
                      return (
                        <UnitTile
                          key={unit.id}
                          unit={unit}
                          icons={icons}
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
                    {unit && <UnitPicture unit={unit} icons={icons} size={24} />}
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

            {ready.length > 0 && (
              <ValueChart
                key={ready.map((history) => history.unit.id).join(",")}
                histories={ready}
                selected={selected}
                onOpenRelease={onOpenRelease}
              />
            )}
            {ready.length > 0 && <ChangeList histories={ready} icons={icons} onOpenRelease={onOpenRelease} />}
          </div>
        </div>
      </article>
    </div>
  );
}

/**
 * A unit's build icon: from the installed game, else from the patch notes'
 * icon set, else its id.
 */
function UnitPicture({ unit, icons, size }: { unit: UnitSummary; icons: UnitIcons | null; size: number }) {
  const local = icons?.units[unit.id];
  const [failed, setFailed] = useState(false);
  const source = local ?? (failed ? null : unit.iconUrl);
  if (!source) return <span className="unit-history-icon-id">{unit.id}</span>;
  return (
    <img
      className="unit-history-picture"
      src={source}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function UnitTile({
  unit,
  icons,
  color,
  disabled,
  onClick,
}: {
  unit: UnitSummary;
  icons: UnitIcons | null;
  color: number | null;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = [unitTitle(unit), unit.name ? unit.description : null, unit.id].filter(Boolean).join(" · ");
  const strategic = unit.strategicIcon ? icons?.strategic[unit.strategicIcon] : undefined;
  return (
    <button
      type="button"
      className={`unit-history-icon faction-${(unit.faction ?? "").toLowerCase()}${color !== null ? " is-selected" : ""}`}
      style={color !== null ? { outlineColor: `var(--color-chart-${color})` } : undefined}
      aria-pressed={color !== null}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <UnitPicture unit={unit} icons={icons} size={40} />
      {strategic && (
        // The game draws strategic icons white and tints them with the
        // player's colour; here the faction's, under a multiply.
        <span className="unit-history-strategic" aria-hidden="true">
          <span className="unit-history-strategic-tint" style={{ maskImage: `url("${strategic}")`, WebkitMaskImage: `url("${strategic}")` }} />
          <img src={strategic} alt="" draggable={false} />
        </span>
      )}
    </button>
  );
}

interface TickedValue {
  id: string;
  /** One unit: the value's colour. Several: unused, the unit gives the colour. */
  color: number;
}

/**
 * The chart with its ticked values. One unit lists the values that changed
 * and colours each; several list the first unit's values and draw each unit
 * in its colour, each value in its own dash.
 */
function ValueChart({
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
  const single = histories.length === 1;
  const keys = useMemo(() => {
    if (!single) return drawableKeys(first);
    const changed = changedKeys(first);
    return changed.length > 0 ? changed : drawableKeys(first);
  }, [first, single]);
  const limit = single ? CHART_COLORS : DASHES.length;
  const [ticked, setTicked] = useState<TickedValue[]>(() => {
    const start = single ? defaultStatKeys(first) : [defaultKey(first)].filter((key): key is UnitValueKey => key !== null);
    return start.map((key, index) => ({ id: valueKeyId(key), color: index + 1 }));
  });
  const releases = first.releases.map((release) => ({ id: release.release, date: release.date }));
  const releaseIds = releases.map((release) => release.id);
  const relative = ticked.length > 1;

  const toggle = (id: string) => {
    setTicked((current) => {
      if (current.some((value) => value.id === id)) return current.filter((value) => value.id !== id);
      if (current.length >= limit) return current;
      // A value keeps its colour while it is ticked: colours follow the value,
      // not its place in the list, and are given out lowest free first.
      const used = new Set(current.map((value) => value.color));
      const color = Array.from({ length: CHART_COLORS }, (_, index) => index + 1).find((candidate) => !used.has(candidate)) ?? 1;
      return [...current, { id, color }];
    });
  };

  const line = (history: UnitHistory, key: UnitValueKey): Pick<ChartSeries, "values" | "describe"> => {
    const raw = alignedValues(history, key, releaseIds);
    if (!relative) return { values: raw };
    const indexed = indexedValues(raw);
    return {
      values: indexed,
      describe: (index: number) => `${formatValue(key, raw[index] ?? null)} (${formatPercentChange(indexed[index] ?? null)})`,
    };
  };

  const series: ChartSeries[] = ticked.flatMap(({ id, color }, valueIndex) => {
    const key = keys.find((candidate) => valueKeyId(candidate) === id);
    if (!key) return [];
    if (single) return [{ key: id, label: valueLabel(key, first, t), color, ...line(first, key) }];
    return histories.flatMap((history) => {
      const own = comparableKey(history, key);
      if (!own) return [];
      return [
        {
          key: `${history.unit.id}:${id}`,
          label: `${unitTitle(history.unit)}: ${valueLabel(own, history, t)}`,
          color: selectionColor(selected.indexOf(history.unit.id)),
          dash: DASHES[valueIndex],
          ...line(history, own),
        },
      ];
    });
  });
  const shownKey = !relative && ticked[0] ? keys.find((candidate) => valueKeyId(candidate) === ticked[0].id) : undefined;
  const lacking = single
    ? []
    : histories.filter((history) =>
        ticked.some(({ id }) => {
          const key = keys.find((candidate) => valueKeyId(candidate) === id);
          return key !== undefined && !comparableKey(history, key);
        }),
      );

  return (
    <section className="unit-history-graph" aria-label={t("changelog.units.chart.title")}>
      <fieldset className="unit-history-values">
        <legend>{t("changelog.units.chart.values")}</legend>
        {keys.map((key) => {
          const id = valueKeyId(key);
          const position = ticked.findIndex((value) => value.id === id);
          const shown = position === -1 ? undefined : ticked[position];
          return (
            <label key={id} className={`unit-history-value${shown ? " is-ticked" : ""}`}>
              <input
                type="checkbox"
                checked={Boolean(shown)}
                disabled={!shown && ticked.length >= limit}
                onChange={() => toggle(id)}
              />
              <LineSample color={shown ? (single ? shown.color : null) : null} dash={shown && !single ? DASHES[position] : undefined} />
              <span>{valueLabel(key, first, t)}</span>
            </label>
          );
        })}
      </fieldset>
      {ticked.length === 0 ? (
        <p className="muted">{t("changelog.units.chart.tickValue")}</p>
      ) : (
        <>
          <p className="unit-history-axis-caption muted">
            {relative ? t("changelog.units.chart.relative") : shownKey ? valueLabel(shownKey, first, t) : ""}
          </p>
          {lacking.length > 0 && (
            <p className="muted">
              {t("changelog.units.lacksValue", { names: lacking.map((history) => unitTitle(history.unit)).join(", ") })}
            </p>
          )}
          <UnitHistoryChart
            releases={releases}
            series={series}
            format={relative ? (value) => `${formatNumber(Math.round(value))}%` : (value) => (shownKey ? formatValue(shownKey, value) : formatNumber(value))}
            floor={relative ? null : 0}
            baseline={relative ? 100 : undefined}
            onOpenRelease={onOpenRelease}
          />
        </>
      )}
    </section>
  );
}

/** Every release that changed one of the units, newest first. */
function ChangeList({
  histories,
  icons,
  onOpenRelease,
}: {
  histories: UnitHistory[];
  icons: UnitIcons | null;
  onOpenRelease: (id: string) => void;
}) {
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
                        <UnitPicture unit={history.unit} icons={icons} size={28} />
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
