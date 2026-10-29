// A replay's build order, two players side by side: when each reached the
// milestones of an opening, which units their factories were ordered to build
// minute by minute, and every build order they gave. The logic is in
// `buildOrder.ts`; this draws it.
//
// Names, tech levels and pictures come from the installed game, through the
// same unit list and icons the Changelog's unit history reads. Without a
// game install the orders still show, by blueprint id, and the milestones
// say they cannot be told apart.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "../../../design-system/Icon";
import { Select } from "../../../design-system/Select";
import type { ReplayAnalysis, UnitSummary } from "../../../ipc/bindings";
import type { UnitIcons } from "../../../ipc/native";
import { ipc } from "../../../ipc/client";
import { useTranslation } from "../../../i18n/useTranslation";
import type { MessageKey } from "../../../i18n";
import { useAppStore } from "../../../store/store";
import { UnitPicture, useUnitIcons } from "../../../shared/components/UnitPicture";
import { analysedPlayers, formatGameTime, type AnalysedPlayer } from "./replayAnalysis";
import {
  buildEntries,
  buildRows,
  defaultPair,
  enhancementWords,
  isEnhancementRemoval,
  MILESTONES,
  milestoneTicks,
  OPENING_MINUTES,
  unitCatalogue,
  unitsPerMinute,
  type BuildRow,
  type MilestoneId,
  type MinuteCount,
} from "./buildOrder";

const MILESTONE_LABELS: Record<MilestoneId, MessageKey> = {
  landFactory: "replays.buildOrder.milestone.landFactory",
  airFactory: "replays.buildOrder.milestone.airFactory",
  navalFactory: "replays.buildOrder.milestone.navalFactory",
  hydrocarbon: "replays.buildOrder.milestone.hydrocarbon",
  energyStorage: "replays.buildOrder.milestone.energyStorage",
  massUpgrade: "replays.buildOrder.milestone.massUpgrade",
  acuUpgrade: "replays.buildOrder.milestone.acuUpgrade",
  t2Factory: "replays.buildOrder.milestone.t2Factory",
  t2Unit: "replays.buildOrder.milestone.t2Unit",
  t3Factory: "replays.buildOrder.milestone.t3Factory",
  t3Unit: "replays.buildOrder.milestone.t3Unit",
  experimental: "replays.buildOrder.milestone.experimental",
};

type Catalogue = ReturnType<typeof unitCatalogue>;

export function ReplayBuildOrderPane({ analysis }: { analysis: ReplayAnalysis }) {
  const { t } = useTranslation();
  const units = useAppStore((state) => state.state.unitHistory.units);
  const listStatus = useAppStore((state) => state.state.unitHistory.listStatus);
  const icons = useUnitIcons();
  const catalogue = useMemo(() => unitCatalogue(units), [units]);
  const players = useMemo(() => analysedPlayers(analysis), [analysis]);
  const [pair, setPair] = useState<[number, number] | null>(() => defaultPair(players));

  // The unit list is the Changelog's; asked for here too, so a build order
  // opened before that tab ever was still has names.
  useEffect(() => {
    if (listStatus.type === "idle") ipc.send({ kind: "UnitHistory", command: { type: "loadList" } });
  }, [listStatus.type]);

  if (players.length === 0 || pair === null) {
    return <p className="replay-detail-empty muted">{t("replays.buildOrder.noPlayers")}</p>;
  }

  const options = players.map((player) => ({ value: player.source, label: player.name }));
  const chosen = pair.map((source) => players.find((player) => player.source === source) ?? players[0]) as [
    AnalysedPlayer,
    AnalysedPlayer,
  ];
  const sides = chosen.map((player) => {
    const entries = buildEntries(analysis, player.source);
    return {
      player,
      rows: buildRows(entries),
      milestones: milestoneTicks(entries, catalogue),
      minutes: unitsPerMinute(entries, catalogue),
    };
  });
  const known = catalogue.size > 0;

  return (
    <div className="replay-build-order">
      <div className="replay-build-order-pick">
        {chosen.map((player, side) => (
          <label key={side} className="replay-build-order-player">
            <span className="replay-activity-swatch" style={{ background: player.color }} aria-hidden />
            <Select
              value={player.source}
              options={options}
              label={t(side === 0 ? "replays.buildOrder.firstPlayer" : "replays.buildOrder.secondPlayer")}
              onChange={(source) => setPair(side === 0 ? [source, pair[1]] : [pair[0], source])}
            />
          </label>
        ))}
      </div>
      <p className="replay-insights-note muted">
        <Icon name="info" size={13} />
        <span>{t("replays.buildOrder.ordersNotCompletions")}</span>
      </p>
      {!known && (
        <p className="replay-insights-note muted">
          <Icon name="alert" size={13} />
          <span>{t("replays.buildOrder.noUnitList")}</span>
        </p>
      )}

      <h3 className="replay-build-order-heading">{t("replays.buildOrder.opening")}</h3>
      <div className="replay-table-scroll">
        <table className="replay-data-table replay-build-order-milestones">
          <thead>
            <tr>
              <th>{t("replays.buildOrder.milestone")}</th>
              {sides.map(({ player }) => (
                <th key={player.source}>{player.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MILESTONES.map((id) => {
              const ticks = sides.map((side) => side.milestones[id]);
              const reached = ticks.filter((tick): tick is number => tick !== null);
              const first = reached.length === 2 ? Math.min(...reached) : null;
              return (
                <tr key={id}>
                  <td className="replay-build-order-label">{t(MILESTONE_LABELS[id])}</td>
                  {ticks.map((tick, side) => (
                    <td key={side} className={tick !== null && tick === first && reached[0] !== reached[1] ? "is-first" : undefined}>
                      {tick === null ? <span className="muted">{t("replays.buildOrder.never")}</span> : formatGameTime(tick)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="replay-build-order-heading">{t("replays.buildOrder.unitsPerMinute", { minutes: OPENING_MINUTES })}</h3>
      <div className="replay-table-scroll">
        <table className="replay-data-table replay-build-order-minutes">
          <thead>
            <tr>
              <th>{t("replays.buildOrder.minute")}</th>
              {sides.map(({ player }) => (
                <th key={player.source}>{player.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: OPENING_MINUTES }, (_, minute) => (
              <tr key={minute}>
                <td className="replay-build-order-label">{minute + 1}</td>
                {sides.map((side) => (
                  <td key={side.player.source}>
                    <MinuteUnits counts={side.minutes[minute]} catalogue={catalogue} icons={icons} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="replay-build-order-heading">{t("replays.buildOrder.everyOrder")}</h3>
      <div className="replay-build-order-ledgers">
        {sides.map((side) => (
          <section key={side.player.source} className="replay-build-order-ledger" aria-label={side.player.name}>
            <h4>
              <span className="replay-activity-swatch" style={{ background: side.player.color }} aria-hidden />
              {side.player.name}
            </h4>
            {side.rows.length === 0 ? (
              <p className="muted">{t("replays.buildOrder.nothingBuilt")}</p>
            ) : (
              <ol>
                {side.rows.map((row) => (
                  <LedgerRow key={row.key} row={row} catalogue={catalogue} icons={icons} />
                ))}
              </ol>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function unitLabel(id: string, catalogue: Catalogue): string {
  const unit = catalogue.get(id);
  if (!unit) return id;
  if (unit.name) return unit.description ? `${unit.name} (${unit.description})` : unit.name;
  // A structure has no name of its own, and every tech level of a mass
  // extractor has the same description: the tech level tells them apart.
  if (unit.description) return unit.tech && unit.tech > 1 && unit.tech < 4 ? `${unit.description} (T${unit.tech})` : unit.description;
  return id;
}

/** A unit the catalogue does not know still gets a picture slot: its id. */
function placeholder(id: string): UnitSummary {
  return {
    id,
    path: "",
    iconUrl: "",
    name: null,
    description: null,
    faction: null,
    tech: null,
    kind: "land",
    strategicIcon: null,
    role: null,
  };
}

function MinuteUnits({ counts, catalogue, icons }: { counts: MinuteCount[]; catalogue: Catalogue; icons: UnitIcons | null }) {
  if (counts.length === 0) return <span className="muted">-</span>;
  return (
    <ul className="replay-build-order-units">
      {counts.map(({ unit, count }) => (
        <li key={unit} title={unitLabel(unit, catalogue)}>
          <UnitPicture unit={catalogue.get(unit) ?? placeholder(unit)} icons={icons} size={22} />
          <span>{count}</span>
        </li>
      ))}
    </ul>
  );
}

function LedgerRow({ row, catalogue, icons }: { row: BuildRow; catalogue: Catalogue; icons: UnitIcons | null }) {
  const { t } = useTranslation();
  let text: string;
  if (row.enhancement !== null) {
    text = t(isEnhancementRemoval(row.enhancement) ? "replays.buildOrder.enhancementRemoved" : "replays.buildOrder.enhancement", {
      name: enhancementWords(row.enhancement),
    });
  } else if (row.queueChange) {
    const name = row.unit ? unitLabel(row.unit, catalogue) : t("replays.buildOrder.unknownOrder");
    text = t(row.quantity > 0 ? "replays.buildOrder.queued" : "replays.buildOrder.dequeued", {
      count: Math.abs(row.quantity),
      name,
    });
  } else {
    const name = unitLabel(row.unit ?? "", catalogue);
    text = row.upgrade ? t("replays.buildOrder.upgrade", { name }) : name;
  }
  return (
    <li className={row.queueChange ? "is-queue-change" : undefined}>
      <span className="replay-build-order-time">{formatGameTime(row.tick)}</span>
      <span className="replay-build-order-picture">
        {row.unit ? (
          <UnitPicture unit={catalogue.get(row.unit) ?? placeholder(row.unit)} icons={icons} size={22} />
        ) : (
          <Icon name="chevronUp" size={15} />
        )}
      </span>
      <span className="replay-build-order-text">{text}</span>
      {!row.queueChange && row.quantity > 1 && <span className="replay-build-order-count">{row.quantity}×</span>}
    </li>
  );
}
