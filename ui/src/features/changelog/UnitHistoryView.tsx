// The Changelog tab's unit history, laid out like a unit database: every unit
// as its build icon with its strategic icon in the corner, by faction and then
// land, air, naval and structures, and the units picked from it compared
// across the game releases.
//
// One unit picked gets a head of its own: its picture, name and tech level,
// and its main values in the newest release with how far each moved since the
// first. Several get a card each and a table of those values side by side.
//
// Under the head, a card with the chart and the values ticked for it. With one
// value ticked the chart shows it in its own numbers; with several, each line
// is a percentage of where it started, since a health of 3000 and a speed of
// 3.4 share no other axis (hovering a release shows the numbers themselves).
// One unit picked gives each value its own colour; several give each unit its
// colour and each value its own dash. Then every release that changed one of
// the units, as a timeline, with the old and the new value the way the patch
// notes print a balance change. A release opens its patch notes in the Game
// section.
//
// Every value comes from the units' blueprints as each release had them (see
// faf-domain's `protocol::unit_history`), the pictures from the installed
// game (`infra::unit_icons`).

import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { FactsStrip } from "../../design-system/FactsStrip";
import { Icon } from "../../design-system/Icon";
import { StatusNotice } from "../../design-system/StatusNotice";
import { ipc } from "../../ipc/client";
import type { UnitIcons } from "../../ipc/native";
import { useAppStore } from "../../store/store";
import { MAX_SELECTED_UNITS } from "../../store/reducers/unitHistory";
import { useTranslation } from "../../i18n/useTranslation";
import { formatNumber } from "../../i18n";
import { useRememberedFilter } from "../../shared/filterMemory";
import { plainError } from "../../shared/plainError";
import { formatDate } from "../../shared/format/dates";
import { factionIdFromName } from "../../shared/factions";
import { FactionIcon } from "../../shared/components/FactionIcon";
import type { UnitChange, UnitChangeRow, UnitHistory, UnitRelease, UnitSummary, UnitValueKey } from "../../ipc/bindings";
import { LineSample, UnitHistoryChart, type ChartSeries } from "./UnitHistoryChart";
import {
  alignedValues,
  CHART_COLORS,
  changedKeys,
  changePercent,
  comparableKey,
  defaultKey,
  defaultStatKeys,
  factsLayout,
  drawableKeys,
  filterUnits,
  formatPercentChange,
  formatValue,
  groupUnits,
  headlineFacts,
  headlineKeys,
  indexedValues,
  releaseOrder,
  releaseVerdict,
  UNIT_FACTIONS,
  UNIT_KIND_LABELS,
  unitColors,
  unitTitle,
  valueKeyId,
  valueLabel,
  valueSpan,
  valueVerdict,
  type Verdict,
  WEAPON_STAT_LABELS,
  UNIT_STAT_LABELS,
} from "./unitHistory";
import { UnitPicture, useUnitIcons } from "../../shared/components/UnitPicture";
import "../../shared/components/changelog-blocks.css";

type Translate = ReturnType<typeof useTranslation>["t"];

const setSelection = (ids: string[]) =>
  ipc.send({ kind: "UnitHistory", command: { type: "setSelection", payload: { ids } } });

/** A grid row's label, "T1" or "ACU", and its full name for the tooltip. */
function tierShort(tech: number | null, t: Translate): string {
  if (tech === null) return t("changelog.units.tierShort.commander");
  if (tech === 4) return t("changelog.units.tierShort.experimental");
  return t("changelog.units.tierShort.tech", { level: tech });
}

function tierTitle(tech: number | null, t: Translate): string {
  if (tech === null) return t("changelog.units.commanders");
  if (tech === 4) return t("changelog.units.experimental");
  return t("changelog.units.techLevel", { level: tech });
}

/** The dashes that tell several values of one unit apart, in order. */
const DASHES = ["", "7 4", "2 3", "10 3 2 3"];

const factionClass = (unit: UnitSummary) => `faction-${(unit.faction ?? "").toLowerCase()}`;

const shortDate = (date: string) => formatDate(date, "", { day: "numeric", month: "short", year: "numeric" });

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
  const picked = selected.map((id) => ({ id, unit: units.find((candidate) => candidate.id === id) }));
  const single = selected.length === 1;
  const colors = unitColors(selected, (id) => picked.find((pick) => pick.id === id)?.unit?.faction);

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
          <div className="settings-segmented unit-history-segmented" role="group" aria-label={t("changelog.units.faction")}>
            <button type="button" className={faction === "" ? "is-active" : undefined} aria-pressed={faction === ""} onClick={() => setFaction("")}>
              {t("changelog.units.all")}
            </button>
            {UNIT_FACTIONS.map((name) => (
              <button
                key={name}
                type="button"
                className={`unit-history-faction-choice faction-${name.toLowerCase()}${faction === name ? " is-active" : ""}`}
                aria-pressed={faction === name}
                title={name}
                onClick={() => setFaction(faction === name ? "" : name)}
              >
                <FactionIcon faction={factionIdFromName(name) ?? 0} size={15} />
              </button>
            ))}
          </div>
          <div className="settings-segmented unit-history-segmented" role="group" aria-label={t("changelog.units.tech")}>
            <button type="button" className={tech === null ? "is-active" : undefined} aria-pressed={tech === null} onClick={() => setTech(null)}>
              {t("changelog.units.all")}
            </button>
            {[1, 2, 3, 4].map((level) => (
              <button
                key={level}
                type="button"
                className={tech === level ? "is-active" : undefined}
                aria-pressed={tech === level}
                title={tierTitle(level, t)}
                onClick={() => setTech(tech === level ? null : level)}
              >
                {tierShort(level, t)}
              </button>
            ))}
          </div>
        </div>
        <div className="changelog-releases unit-history-grid-scroll" aria-label={t("changelog.units.list")}>
          {listStatus.type === "loading" && units.length === 0 && (
            <p className="changelog-list-note">{t("changelog.units.listLoading")}</p>
          )}
          {listStatus.type === "ready" && groups.length === 0 && (
            <p className="changelog-list-note">{t("changelog.units.noMatch")}</p>
          )}
          {groups.map((group) => (
            <section key={group.faction} className={`unit-history-faction faction-${group.faction.toLowerCase()}`}>
              <h3>
                <FactionIcon faction={factionIdFromName(group.faction) ?? 0} size={14} />
                {group.faction}
              </h3>
              {group.kinds.map((kind) => (
                <div key={kind.kind} className="unit-history-kind">
                  <span className="unit-history-kind-label">{t(UNIT_KIND_LABELS[kind.kind])}</span>
                  {/* One row per tech level, as a build menu has them. */}
                  {kind.tiers.map((tier) => (
                    <div key={tier.tech ?? "commander"} className="unit-history-tier">
                      <span className="unit-history-tier-label" title={tierTitle(tier.tech, t)}>
                        {tierShort(tier.tech, t)}
                      </span>
                      <div className="unit-history-icons">
                        {tier.units.map((unit) => {
                          const color = colors[unit.id] ?? null;
                          return (
                            <UnitTile
                              key={unit.id}
                              unit={unit}
                              icons={icons}
                              color={color}
                              disabled={color === null && full}
                              onClick={() => toggle(unit.id)}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </div>
      </aside>

      <article
        className="changelog-note surface-panel unit-history-detail"
        aria-busy={selected.some((id) => histories[id]?.type === "loading") || undefined}
      >
        {selected.length === 0 ? (
          <EmptyState icon="units" title={t("changelog.units.pickTitle")} hint={t("changelog.units.pick")} />
        ) : (
          <div className="changelog-note-scroll">
            <div className="unit-history-body">
              {single && picked[0].unit ? (
                <UnitHero
                  unit={picked[0].unit}
                  history={ready[0]}
                  icons={icons}
                  onRemove={() => toggle(picked[0].id)}
                  onOpenRelease={onOpenRelease}
                />
              ) : (
                <CompareHead picked={picked} colors={colors} icons={icons} full={full} onRemove={toggle} />
              )}

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

              {!single && ready.length > 0 && <CompareTable histories={ready} colors={colors} icons={icons} />}
              {ready.length > 0 && (
                <ValueChart
                  key={ready.map((history) => history.unit.id).join(",")}
                  histories={ready}
                  colors={colors}
                  onOpenRelease={onOpenRelease}
                />
              )}
              {ready.length > 0 && <ChangeList histories={ready} icons={icons} onOpenRelease={onOpenRelease} />}
            </div>
          </div>
        )}
      </article>
    </div>
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
  /** Its colour while picked. */
  color: string | null;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = [unitTitle(unit), unit.name ? unit.description : null, unit.id].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className={`unit-history-icon ${factionClass(unit)}${color !== null ? " is-selected" : ""}`}
      style={color !== null ? { outlineColor: color } : undefined}
      aria-pressed={color !== null}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <UnitPicture unit={unit} icons={icons} size={40} />
      <StrategicIcon unit={unit} icons={icons} />
    </button>
  );
}

/** The strategic icon at its own size, in its faction's colour as the unit
 * database draws it (the shell tints it). The game draws it in the player's
 * colour, and a faction tile has no player. */
function StrategicIcon({ unit, icons }: { unit: UnitSummary; icons: UnitIcons | null }) {
  const strategic = unit.strategicIcon ? icons?.strategic[unit.strategicIcon]?.[(unit.faction ?? "").toLowerCase()] : undefined;
  if (!strategic) return null;
  return <span className="unit-history-strategic" aria-hidden="true" style={{ backgroundImage: `url("${strategic}")` }} />;
}

/** "UEF · Tech 1 · Land", the line under a unit's name. */
function UnitMeta({ unit, t }: { unit: UnitSummary; t: Translate }) {
  const faction = unit.faction ? factionIdFromName(unit.faction) : null;
  return (
    <span className="unit-history-meta">
      {faction !== null && <FactionIcon faction={faction} size={13} />}
      <span className="unit-history-meta-text">
        {[unit.faction, tierTitle(unit.tech, t), t(UNIT_KIND_LABELS[unit.kind])].filter(Boolean).join(" · ")}
      </span>
      <code>{unit.id}</code>
    </span>
  );
}

/** How far a value moved, as a tag in green for a buff and red for a nerf. */
function Delta({ keyOf, before, after }: { keyOf: UnitValueKey; before: number | null; after: number | null }) {
  const change = changePercent(before, after);
  if (!change) return null;
  const verdict = valueVerdict(keyOf, before, after);
  return <span className={`unit-history-delta${verdict ? ` is-${verdict}` : ""}`}>{change}</span>;
}

/** A value now, and how far it moved since the first release that had it. */
function FactValue({ keyOf, now, first }: { keyOf: UnitValueKey; now: number; first: number }) {
  return (
    <>
      {formatValue(keyOf, now)}
      <Delta keyOf={keyOf} before={first} after={now} />
    </>
  );
}

/** One picked unit: its picture large, its name, and its values now. */
function UnitHero({
  unit,
  history,
  icons,
  onRemove,
  onOpenRelease,
}: {
  unit: UnitSummary;
  history: UnitHistory | undefined;
  icons: UnitIcons | null;
  onRemove: () => void;
  onOpenRelease: (id: string) => void;
}) {
  const { t } = useTranslation();
  const all = history ? headlineFacts(history) : [];
  const layout = factsLayout(all.length);
  const facts = all.slice(0, layout.shown);
  const newest = history?.changes.reduce<UnitChangeRow | null>(
    (latest, row) => (latest === null || releaseOrder(row.release) > releaseOrder(latest.release) ? row : latest),
    null,
  );
  const firstRelease = history?.releases.find((release) => release.source.type !== "absent" && release.source.type !== "unavailable");
  const verdicts = history?.changes.map((row) => releaseVerdict(row.changes)) ?? [];
  const buffs = verdicts.filter((verdict) => verdict === "buff").length;
  const nerfs = verdicts.filter((verdict) => verdict === "nerf").length;
  return (
    <section className={`unit-history-hero ${factionClass(unit)}`}>
      <div className="unit-history-hero-head">
        <div className="unit-history-hero-picture">
          <UnitPicture unit={unit} icons={icons} size={64} />
          <StrategicIcon unit={unit} icons={icons} />
        </div>
        <div className="unit-history-hero-text">
          <h2>{unitTitle(unit)}</h2>
          {unit.name && unit.description && <p className="unit-history-hero-description">{unit.description}</p>}
          <UnitMeta unit={unit} t={t} />
        </div>
        <div className="unit-history-hero-side">
          {history && (
            <span className="unit-history-hero-count">
              <strong>{formatNumber(history.changes.length)}</strong>
              {t("changelog.units.changedIn", { count: history.changes.length })}
            </span>
          )}
          {buffs + nerfs > 0 && (
            <span className="unit-history-hero-verdicts">
              {buffs > 0 && <VerdictMark verdict="buff">{t("changelog.units.buffCount", { count: buffs })}</VerdictMark>}
              {nerfs > 0 && <VerdictMark verdict="nerf">{t("changelog.units.nerfCount", { count: nerfs })}</VerdictMark>}
            </span>
          )}
          {newest && (
            <button type="button" className="unit-history-release" onClick={() => onOpenRelease(newest.release)}>
              {t("changelog.units.lastChanged", { release: newest.release })}
            </button>
          )}
        </div>
        <Button className="icon-button unit-history-hero-remove" aria-label={t("changelog.units.remove", { name: unitTitle(unit) })} onClick={onRemove}>
          <Icon name="close" size={14} />
        </Button>
      </div>
      {facts.length > 0 && (
        <FactsStrip
          className="unit-history-facts"
          columns={layout.columns}
          groups={[
            {
              ariaLabel: t("changelog.units.current", { release: firstRelease?.release ?? "" }),
              facts: facts.map((fact) => ({
                id: valueKeyId(fact.key),
                label: history ? valueLabel(fact.key, history, t) : "",
                value: <FactValue keyOf={fact.key} now={fact.now} first={fact.first} />,
              })),
            },
          ]}
        />
      )}
      {facts.length > 0 && firstRelease && (
        <p className="unit-history-facts-caption">{t("changelog.units.current", { release: firstRelease.release })}</p>
      )}
    </section>
  );
}

/** Several picked units: a card each, in its faction's colour. */
function CompareHead({
  picked,
  colors,
  icons,
  full,
  onRemove,
}: {
  picked: Array<{ id: string; unit: UnitSummary | undefined }>;
  colors: Record<string, string>;
  icons: UnitIcons | null;
  full: boolean;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="unit-history-compare-head">
      <ul className="unit-history-cards" aria-label={t("changelog.units.selected")}>
        {picked.map(({ id, unit }) => (
          <li key={id} className="unit-history-card-unit" style={{ borderTopColor: colors[id] }}>
            {unit && (
              <span className={`unit-history-card-picture ${factionClass(unit)}`}>
                <UnitPicture unit={unit} icons={icons} size={36} />
              </span>
            )}
            <span className="unit-history-card-text">
              <strong>{unit ? unitTitle(unit) : id}</strong>
              {unit && <UnitMeta unit={unit} t={t} />}
            </span>
            <button
              type="button"
              className="unit-history-chip-remove"
              aria-label={t("changelog.units.remove", { name: unit ? unitTitle(unit) : id })}
              onClick={() => onRemove(id)}
            >
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
      </ul>
      <Button onClick={() => setSelection([])}>{t("changelog.units.clear")}</Button>
      {full && <p className="muted unit-history-full">{t("changelog.units.full", { count: MAX_SELECTED_UNITS })}</p>}
    </section>
  );
}

/** The picked units' main values in the newest release, side by side. */
function CompareTable({
  histories,
  colors,
  icons,
}: {
  histories: UnitHistory[];
  colors: Record<string, string>;
  icons: UnitIcons | null;
}) {
  const { t } = useTranslation();
  const first = histories[0];
  const keys = headlineKeys(first, 10);
  return (
    <section className="unit-history-card">
      <header className="unit-history-card-head">
        <h2>{t("changelog.units.compare")}</h2>
      </header>
      <div className="unit-history-table-scroll">
        <table className="unit-history-table">
          <thead>
            <tr>
              <th scope="col">{t("changelog.units.value")}</th>
              {histories.map((history) => (
                <th
                  key={history.unit.id}
                  scope="col"
                  style={{ boxShadow: `inset 0 2px 0 ${colors[history.unit.id]}` }}
                >
                  <span className="unit-history-table-unit">
                    <UnitPicture unit={history.unit} icons={icons} size={22} />
                    {unitTitle(history.unit)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={valueKeyId(key)}>
                {/* A weapon value by its stat alone: each unit's column takes it
                    from its own weapon, and those are named differently. */}
                <th scope="row">{t(key.type === "unit" ? UNIT_STAT_LABELS[key.payload.stat] : WEAPON_STAT_LABELS[key.payload.stat])}</th>
                {histories.map((history) => {
                  const own = comparableKey(history, key);
                  const span = own ? valueSpan(alignedValues(history, own, history.releases.map((release) => release.release))) : null;
                  return (
                    <td key={history.unit.id}>
                      {own && span ? <FactValue keyOf={own} now={span.now} first={span.first} /> : <span className="muted">–</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface TickedValue {
  id: string;
  /** One unit: the value's colour. Several: unused, the unit gives the colour. */
  color: number;
}

/** The ticked values' list, grouped: the unit's own, then one group per weapon. */
function valueGroups(keys: UnitValueKey[], history: UnitHistory): Array<{ title: string; keys: UnitValueKey[] }> {
  const groups: Array<{ title: string; keys: UnitValueKey[] }> = [];
  const own = keys.filter((key) => key.type === "unit");
  if (own.length > 0) groups.push({ title: unitTitle(history.unit), keys: own });
  for (const key of keys) {
    if (key.type !== "weapon") continue;
    const title = history.weapons.find((weapon) => weapon.key === key.payload.weapon)?.name ?? key.payload.weapon;
    const group = groups.find((candidate) => candidate.title === title && candidate.keys[0]?.type === "weapon");
    if (group) group.keys.push(key);
    else groups.push({ title, keys: [key] });
  }
  return groups;
}

/**
 * The chart with its ticked values. One unit lists the values that changed
 * and colours each; several list the first unit's values and draw each unit
 * in its colour, each value in its own dash.
 */
function ValueChart({
  histories,
  colors,
  onOpenRelease,
}: {
  histories: UnitHistory[];
  /** Each unit's colour, by id: its faction's (`unitColors`). */
  colors: Record<string, string>;
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
    if (single) return [{ key: id, label: valueLabel(key, first, t), color: `var(--color-chart-${color})`, ...line(first, key) }];
    return histories.flatMap((history) => {
      const own = comparableKey(history, key);
      if (!own) return [];
      return [
        {
          key: `${history.unit.id}:${id}`,
          label: `${unitTitle(history.unit)}: ${valueLabel(own, history, t)}`,
          color: colors[history.unit.id],
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
    <section className="unit-history-card unit-history-graph" aria-label={t("changelog.units.chart.title")}>
      <header className="unit-history-card-head">
        <h2>{t("changelog.units.chart.title")}</h2>
        {ticked.length > 0 && (
          <p className="muted">{relative ? t("changelog.units.chart.relative") : shownKey ? valueLabel(shownKey, first, t) : ""}</p>
        )}
      </header>
      <div className="unit-history-graph-body">
        <div className="unit-history-graph-plot">
          {lacking.length > 0 && (
            <p className="muted">
              {t("changelog.units.lacksValue", { names: lacking.map((history) => unitTitle(history.unit)).join(", ") })}
            </p>
          )}
          {ticked.length === 0 ? (
            <p className="unit-history-chart-empty">{t("changelog.units.chart.tickValue")}</p>
          ) : (
            <UnitHistoryChart
              releases={releases}
              series={series}
              format={relative ? (value) => `${formatNumber(Math.round(value))}%` : (value) => (shownKey ? formatValue(shownKey, value) : formatNumber(value))}
              floor={relative ? null : 0}
              baseline={relative ? 100 : undefined}
              onOpenRelease={onOpenRelease}
            />
          )}
        </div>
        <fieldset className="unit-history-values">
          <legend>{t("changelog.units.chart.values")}</legend>
          {valueGroups(keys, first).map((group) => (
            <div key={`${group.keys[0].type}:${group.title}`} className="unit-history-value-group">
              <span className="unit-history-value-group-title">{group.title}</span>
              {group.keys.map((key) => {
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
                    <span>{key.type === "unit" ? t(UNIT_STAT_LABELS[key.payload.stat]) : t(WEAPON_STAT_LABELS[key.payload.stat])}</span>
                    <LineSample color={shown && single ? `var(--color-chart-${shown.color})` : null} dash={shown && !single ? DASHES[position] : undefined} />
                  </label>
                );
              })}
            </div>
          ))}
        </fieldset>
      </div>
    </section>
  );
}

/** Every release that changed one of the units, newest first, as a timeline. */
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
    return [...byRelease.values()]
      .sort((left, right) => releaseOrder(right.release) - releaseOrder(left.release))
      .map((row) => ({ ...row, verdict: releaseVerdict(row.entries.flatMap(({ row: changes }) => changes.changes)) }));
  }, [histories]);
  const several = histories.length > 1;

  return (
    <section className="unit-history-card unit-history-changes" aria-label={t("changelog.units.changes")}>
      <header className="unit-history-card-head">
        <h2>{t("changelog.units.changes")}</h2>
        {rows.length > 0 && <span className="unit-history-count">{formatNumber(rows.length)}</span>}
        {rows.some((row) => row.verdict !== null) && (
          <span className="unit-history-legend">
            <VerdictMark verdict="buff">{t("changelog.units.verdict.buff")}</VerdictMark>
            <VerdictMark verdict="nerf">{t("changelog.units.verdict.nerf")}</VerdictMark>
            <VerdictMark verdict="mixed">{t("changelog.units.verdict.mixed")}</VerdictMark>
          </span>
        )}
      </header>
      {rows.length === 0 ? (
        <p className="muted unit-history-card-note">{t("changelog.units.noChanges")}</p>
      ) : (
        <ol className="unit-history-timeline">
          {rows.map((row) => (
            <li key={row.release} className="unit-history-timeline-row">
              <span
                className={`unit-history-timeline-node${row.verdict ? ` is-${row.verdict}` : ""}`}
                role={row.verdict ? "img" : undefined}
                aria-label={row.verdict ? t(`changelog.units.verdict.${row.verdict}`) : undefined}
                title={row.verdict ? t(`changelog.units.verdict.${row.verdict}`) : undefined}
                aria-hidden={row.verdict ? undefined : true}
              />
              <div className="unit-history-timeline-release">
                <button type="button" className="unit-history-release" onClick={() => onOpenRelease(row.release)}>
                  {row.release}
                </button>
                {row.date && <time dateTime={row.date}>{shortDate(row.date)}</time>}
              </div>
              <div className="unit-history-timeline-units">
                {row.entries.map(({ history, row: changes }) => (
                  <div key={history.unit.id} className="unit-history-change-unit">
                    {several && (
                      <div className="unit-history-change-unit-head">
                        <span className={`unit-history-change-picture ${factionClass(history.unit)}`}>
                          <UnitPicture unit={history.unit} icons={icons} size={24} />
                        </span>
                        <span>{unitTitle(history.unit)}</span>
                      </div>
                    )}
                    <SourceTag release={history.releases.find((release) => release.release === row.release)} t={t} />
                    <ul className="unit-history-change-lines">
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

/** A buff, a nerf or both, as a square in its colour and a word. */
function VerdictMark({ verdict, children }: { verdict: Verdict | "mixed"; children: string }) {
  return (
    <span className={`unit-history-verdict is-${verdict}`}>
      <span className="unit-history-verdict-mark" aria-hidden="true" />
      {children}
    </span>
  );
}

function SourceTag({ release, t }: { release: UnitRelease | undefined; t: Translate }) {
  if (release?.source.type !== "baseGame") return null;
  return <span className="unit-history-source">{t("changelog.units.baseGame")}</span>;
}

/** A change the way the patch notes print one: the old value struck through
 * in red, an arrow, the new value in green, and how far it moved. */
function ChangeLine({ change, history, t }: { change: UnitChange; history: UnitHistory; t: Translate }) {
  switch (change.type) {
    case "added":
      return <span className="changelog-new">{t("changelog.units.added")}</span>;
    case "removed":
      return <span className="changelog-old">{t("changelog.units.removed")}</span>;
    case "categories":
      return (
        <span className="unit-history-change-line">
          <span className="unit-history-change-label">{t("changelog.units.categories")}</span>
          <span className="unit-history-change-values">
            {change.payload.removed.map((category) => (
              <span key={`-${category}`} className="changelog-old">{category}</span>
            ))}
            {change.payload.added.map((category) => (
              <span key={`+${category}`} className="changelog-new">{category}</span>
            ))}
          </span>
        </span>
      );
    case "value": {
      const { key, before, after } = change.payload;
      return (
        <span className="unit-history-change-line">
          <span className="unit-history-change-label">{valueLabel(key, history, t)}</span>
          <span className="unit-history-change-values">
            {before !== null && <span className="unit-history-old">{formatValue(key, before)}</span>}
            {before !== null && after !== null && <Icon name="arrowRight" size={12} />}
            {after !== null && <span className="unit-history-new">{formatValue(key, after)}</span>}
            <Delta keyOf={key} before={before} after={after} />
          </span>
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
    <p className="muted unit-history-card-note" title={reason}>
      {several ? `${unitTitle(history.unit)}: ${text}` : text}
    </p>
  );
}
