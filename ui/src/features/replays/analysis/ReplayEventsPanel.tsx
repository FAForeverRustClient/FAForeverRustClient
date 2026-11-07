import { useMemo, useState } from "react";
import type { ReplayAnalysis } from "../../../ipc/bindings";
import { native, type UnitIcons } from "../../../ipc/native";
import { MultiSelect } from "../../../design-system/MultiSelect";
import { FactionIcon } from "../../../shared/components/FactionIcon";
import { useUnitIcons } from "../../../shared/useUnitIcons";
import { PlayerName } from "../../../shared/components/nameColors";
import { useTranslation } from "../../../i18n/useTranslation";
import { formatGameTime, playerColor } from "./replayAnalysis";
import { EVENT_KINDS, replayTimeline, type ReplayTimelineEvent } from "./replayEvents";
import "./replay-events.css";

const FACTION_NAMES: Readonly<Record<number, string>> = { 1: "uef", 2: "aeon", 3: "cybran", 4: "seraphim" };

function EventPicture({ event, faction, icons }: { event: ReplayTimelineEvent; faction: number; icons: UnitIcons | null }) {
  const [failed, setFailed] = useState(0);
  const enhancement = icons && event.enhancement && FACTION_NAMES[faction]
    ? native.enhancementIconUrl(FACTION_NAMES[faction], event.enhancement) : null;
  const sources = [enhancement, event.unit ? icons?.units[event.unit] : null].filter((source): source is string => Boolean(source));
  const source = sources[failed];
  return source ? <img className="replay-event-picture" src={source} width={28} height={28} alt="" loading="lazy" onError={() => setFailed((index) => index + 1)} />
    : faction >= 1 && faction <= 4 ? <FactionIcon faction={faction} size={22} /> : null;
}

export function ReplayEventsPanel({ analysis }: { analysis: ReplayAnalysis }) {
  const { t } = useTranslation();
  const [players, setPlayers] = useState<string[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [showTeams, setShowTeams] = useState(false);
  const bySource = useMemo(() => new Map(analysis.armies.filter((army) => army.source >= 0).map((army) => [army.source, army])), [analysis.armies]);
  const timeline = useMemo(() => replayTimeline(analysis).map((event, id) => ({ ...event, id })), [analysis]);
  const icons = useUnitIcons(timeline.some((event) => Boolean(event.unit || event.enhancement)));
  const events = useMemo(() => timeline.filter((event) =>
    (players.length === 0 || players.includes(String(event.source))) && (kinds.length === 0 || kinds.includes(event.kind)),
  ), [timeline, players, kinds]);

  if (timeline.length === 0) return <p className="replay-detail-empty muted">{t("replays.insights.noEvents")}</p>;

  return <>
    <div className="replay-insights-toolbar replay-events-toolbar">
      <MultiSelect label={t("replays.events.players")} options={[...bySource.values()].map((army) => ({ value: String(army.source), label: army.name }))}
        selected={players} onChange={setPlayers} anyLabel={t("replays.insights.everyone")} layout="inline" />
      <MultiSelect label={t("replays.events.types")} options={EVENT_KINDS.map((kind) => ({ value: kind, label: t(`replays.events.${kind}`) }))}
        selected={kinds} onChange={setKinds} layout="inline" />
      <label className="replay-event-team-toggle"><input type="checkbox" checked={showTeams} onChange={(event) => setShowTeams(event.target.checked)} />{t("replays.events.showTeams")}</label>
    </div>
    <div className="replay-table-scroll"><table className="replay-data-table"><thead><tr>
      <th>{t("replays.detail.chatTime")}</th><th>{t("replays.insights.player")}</th><th>{t("replays.insights.event")}</th>
    </tr></thead><tbody>
      {events.map((event) => {
        const army = bySource.get(event.source);
        return <tr key={event.id} data-kind={event.kind}>
          <td className="replay-chat-time">{formatGameTime(event.tick)}</td>
          <td><span className="replay-activity-player">
            {army && <span className="replay-activity-swatch" style={{ background: playerColor(army.color) }} aria-hidden />}
            <PlayerName name={army?.name ?? t("replays.insights.unknownPlayer")} />
            {showTeams && army && <small className="muted replay-event-team">{army.team > 1 ? t("replays.events.team", { team: army.team - 1 }) : t("replays.roster.freeForAll")}</small>}
          </span></td>
          <td><span className="replay-event-description"><EventPicture key={`${army?.faction}-${event.enhancement}-${event.unit}`} event={event} faction={army?.faction ?? 0} icons={icons} />
            <span title={event.kind === "lastCommand" ? t("replays.events.lastCommandHint") : undefined}>
              {event.kind === "lastCommand" ? t("replays.events.lastCommand") : event.text}
            </span>
          </span></td>
        </tr>;
      })}
      {events.length === 0 && <tr><td colSpan={3} className="replay-table-empty muted">{t("replays.events.empty")}</td></tr>}
    </tbody></table></div>
  </>;
}
