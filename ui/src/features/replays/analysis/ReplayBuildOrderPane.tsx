// A replay's build order: when two players reached the milestones of an
// opening, side by side, and under it each player's build order as lanes,
// the way the maintainer's own build order analyser (bo-sheppy) draws one.
// The lanes open on the first five minutes and widen to the whole game.
//
// Names, tech levels, build times and pictures come from the installed game,
// through the same unit list and icons the Changelog's unit history reads.
// Without a game install the orders still show, by blueprint id, and the pane
// says why the milestones are empty.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../../design-system/Icon";
import { Select } from "../../../design-system/Select";
import type { ReplayAnalysis } from "../../../ipc/bindings";
import { ipc } from "../../../ipc/client";
import { useTranslation } from "../../../i18n/useTranslation";
import type { MessageKey } from "../../../i18n";
import { useAppStore } from "../../../store/store";
import { useUnitIcons } from "../../../shared/components/UnitPicture";
import { analysedPlayers, formatGameTime, TICKS_PER_SECOND, type AnalysedPlayer } from "./replayAnalysis";
import { buildEntries, defaultPair, MILESTONES, milestoneTicks, unitCatalogue, type MilestoneId } from "./buildOrder";
import { buildFlow, flowSpan } from "./buildFlow";
import { ReplayBuildFlow } from "./ReplayBuildFlow";

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

const MINUTE = 60 * TICKS_PER_SECOND;
/** What the lanes show across their width: the opening first, then wider. */
const WINDOWS = [5, 10, 20] as const;
type WindowChoice = (typeof WINDOWS)[number] | "all";

/** The pane's width, so five minutes fill it whatever the dialog's size. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function ReplayBuildOrderPane({ analysis }: { analysis: ReplayAnalysis }) {
  const { t } = useTranslation();
  const units = useAppStore((state) => state.state.unitHistory.units);
  const listStatus = useAppStore((state) => state.state.unitHistory.listStatus);
  const icons = useUnitIcons();
  const catalogue = useMemo(() => unitCatalogue(units), [units]);
  const players = useMemo(() => analysedPlayers(analysis), [analysis]);
  const [pair, setPair] = useState<[number, number] | null>(() => defaultPair(players));
  const [windowChoice, setWindowChoice] = useState<WindowChoice>(5);
  const [frameRef, frameWidth] = useWidth();

  // The unit list is the Changelog's; asked for here too, so a build order
  // opened before that tab ever was still has names.
  useEffect(() => {
    if (listStatus.type === "idle") ipc.send({ kind: "UnitHistory", command: { type: "loadList" } });
  }, [listStatus.type]);

  const sides = useMemo(
    () =>
      (pair ?? []).map((source) => {
        const player: AnalysedPlayer = players.find((candidate) => candidate.source === source) ?? players[0];
        const entries = buildEntries(analysis, player.source);
        return {
          player,
          milestones: milestoneTicks(entries, catalogue),
          lanes: buildFlow(analysis, player.source, player.faction, catalogue),
        };
      }),
    [analysis, catalogue, pair, players],
  );

  if (players.length === 0 || pair === null) {
    return <p className="replay-detail-empty muted">{t("replays.buildOrder.noPlayers")}</p>;
  }

  const options = players.map((player) => ({ value: player.source, label: player.name }));
  const known = catalogue.size > 0;
  // The whole game, not the last reckoned build: a reckoning that runs past
  // the end describes builds that never ran.
  const span = Math.max(5 * MINUTE, analysis.ticks > 0 ? analysis.ticks : Math.max(...sides.map((side) => flowSpan(side.lanes, 0))));
  const window = windowChoice === "all" ? span : Math.min(windowChoice * MINUTE, span);

  return (
    <div className="replay-build-order" ref={frameRef}>
      <div className="replay-build-order-pick">
        {sides.map(({ player }, side) => (
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
      {!known && (
        <p className="replay-insights-note muted">
          <Icon name="alert" size={13} />
          <span>{t("replays.buildOrder.noUnitList")}</span>
        </p>
      )}

      <h3 className="replay-build-order-heading">{t("replays.buildOrder.opening")}</h3>
      <p className="replay-insights-note muted">
        <Icon name="info" size={13} />
        <span>{t("replays.buildOrder.ordersNotCompletions")}</span>
      </p>
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

      <div className="replay-build-order-flow-head">
        <h3 className="replay-build-order-heading">{t("replays.buildOrder.lanes")}</h3>
        <div className="settings-segmented" role="group" aria-label={t("replays.buildOrder.windowAria")}>
          {[...WINDOWS, "all" as const].map((choice) => (
            <button
              key={choice}
              type="button"
              className={choice === windowChoice ? "is-active" : undefined}
              aria-pressed={choice === windowChoice}
              onClick={() => setWindowChoice(choice)}
            >
              {choice === "all" ? t("replays.buildOrder.windowAll") : t("replays.buildOrder.windowMinutes", { minutes: choice })}
            </button>
          ))}
        </div>
      </div>
      <p className="replay-insights-note muted">
        <Icon name="info" size={13} />
        <span>{t("replays.buildOrder.estimated")}</span>
      </p>
      {sides.map((side) => (
        <section key={side.player.source} className="replay-build-order-side" aria-label={side.player.name}>
          <h4>
            <span className="replay-activity-swatch" style={{ background: side.player.color }} aria-hidden />
            {side.player.name}
          </h4>
          {side.lanes.length === 0 ? (
            <p className="muted">{t("replays.buildOrder.nothingBuilt")}</p>
          ) : (
            <ReplayBuildFlow
              lanes={side.lanes}
              span={span}
              window={window}
              width={frameWidth}
              catalogue={catalogue}
              icons={icons}
            />
          )}
        </section>
      ))}
    </div>
  );
}
