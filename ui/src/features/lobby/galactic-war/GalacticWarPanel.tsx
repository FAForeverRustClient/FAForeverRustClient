// Galactic War: a way to play that lives in its own application.
//
// The fourth surface inside Play, beside Custom, Matchmaker and Co-op. Layout
// follows Fichom's mockup: an info column on the left, the cycle and faction
// boards in the middle with the launch button straddling their seam, and a
// static explainer on the right. Its parts are the client's shared ones: raised
// heads, facts strips, and links one to a line.
//
// Everything it decides comes from the slice: the button's job is a function
// of `galacticWarActions`, never of local component state, so the backend and
// the button can never disagree about whether something is installed.

import { useEffect, type CSSProperties } from "react";
import { Button } from "../../../design-system/Button";
import { FactsStrip, type Fact } from "../../../design-system/FactsStrip";
import { Icon } from "../../../design-system/Icon";
import { StatusNotice } from "../../../design-system/StatusNotice";
import { ipc } from "../../../ipc/client";
import { useTranslation } from "../../../i18n/useTranslation";
import type { MessageKey } from "../../../i18n";
import { useAppStore } from "../../../store/store";
import { FactionIcon } from "../../../shared/components/FactionIcon";
import { galacticWarFactionLabel } from "../../../shared/factions";
import { openHttpsUrl } from "../../../shared/externalLinks";
import { plainError } from "../../../shared/plainError";
import { canLaunch, installTarget, isBusy, updateAvailable } from "../../../shared/rules/galacticWarActions";
import { onlineCommanders } from "./galacticWarOnline";
import { ringSegments, type RingSegment } from "./galacticWarRing";
import type { PlayModePanelProps } from "../PlayModeTabs";
import "./galactic-war.css";

const refresh = () => ipc.send({ kind: "GalacticWar", command: { type: "refresh" } });
const play = () => ipc.send({ kind: "GalacticWar", command: { type: "play" } });

/**
 * Outside destinations for the left column.
 *
 * Only what there is actual evidence for: the Galactic War web front end (the
 * one origin the gateway's CORS policy names) and FAF's forum. A Discord
 * invite and a dedicated forum category belong here too, but inventing those
 * URLs would ship links that go nowhere: they want adding once someone who
 * runs Galactic War supplies them.
 */
const LINKS: ReadonlyArray<{ key: MessageKey; url: string }> = [
  { key: "lobby.galacticWar.link.site", url: "https://galactic-war.spidarna.com" },
  { key: "lobby.galacticWar.link.forum", url: "https://forum.faforever.com" },
];

/** The explainer sections on the right. Static copy, no data source. */
const HOW_IT_WORKS: ReadonlyArray<{ title: MessageKey; body: MessageKey }> = [
  { title: "lobby.galacticWar.how.galaxy.title", body: "lobby.galacticWar.how.galaxy.body" },
  { title: "lobby.galacticWar.how.avatar.title", body: "lobby.galacticWar.how.avatar.body" },
  { title: "lobby.galacticWar.how.battles.title", body: "lobby.galacticWar.how.battles.body" },
  { title: "lobby.galacticWar.how.client.title", body: "lobby.galacticWar.how.client.body" },
];

/** Shown where a figure has no value yet. An en dash: the repository's prose
 *  rules forbid em dashes, and a word here would misalign the number columns. */
const NO_VALUE = "–";

const RING_RADIUS = 78;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** Keeps neighbouring arcs visually separate without distorting the ratio. */
const RING_GAP = 4;
/** The arc drawn while a stage has no fraction to report. */
const RING_BUSY_ARC = RING_CIRCUMFERENCE * 0.18;

/** Bytes as a whole number of MB: an archive size, not a measurement. */
function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/**
 * Whole days since `startedAt`, or `null` when it cannot be read.
 *
 * The gateway has been seen sending two formats: `2026-01-01T00:00:00.000Z`
 * and `2026-03-15 22:55:15`. The second is not ISO 8601, so it is normalised
 * rather than handed to `Date` and hoped for.
 */
export function cycleAgeInDays(startedAt: string, now: number = Date.now()): number | null {
  const raw = startedAt.trim();
  if (raw === "") return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? raw.replace(" ", "T")
    : raw;
  const started = new Date(normalized).getTime();
  if (Number.isNaN(started)) return null;
  const days = Math.floor((now - started) / (24 * 60 * 60 * 1000));
  return days < 0 ? null : days;
}

interface ArcProps {
  className?: string;
  color?: string;
  /** Fraction of the ring this arc covers, `0`..`1`. */
  length: number;
  /** Where it starts, as a fraction of the ring. */
  offset?: number;
  round?: boolean;
}

function RingArc({ className, color, length, offset = 0, round = false }: ArcProps) {
  const drawn = Math.max(0, length * RING_CIRCUMFERENCE - (round ? 0 : RING_GAP));
  return (
    <circle
      className={className}
      cx="100"
      cy="100"
      r={RING_RADIUS}
      fill="none"
      stroke={color}
      strokeWidth="9"
      strokeLinecap={round ? "round" : "butt"}
      strokeDasharray={`${drawn} ${RING_CIRCUMFERENCE - drawn}`}
      strokeDashoffset={-offset * RING_CIRCUMFERENCE}
    />
  );
}

/**
 * The galaxy as one bar, every faction's share in the gateway's order, with
 * the card's own faction lit and the others dimmed: the share, and where it
 * stands against the rest, in one line.
 */
function TerritoryShare({ segments, own }: { segments: RingSegment[]; own: number }) {
  return (
    <span className="gw-share-bar" aria-hidden="true">
      {segments.map((segment, index) => (
        <span
          key={segment.name}
          className={index === own ? "is-own" : undefined}
          style={{ flexGrow: segment.share, background: segment.color }}
        />
      ))}
    </span>
  );
}

/** Every planet a faction holds, the ring's whole. */
function planetsTotal(segments: readonly RingSegment[]): number {
  return segments.reduce((total, segment) => total + segment.planets, 0);
}

function TerritoryArc({ segment }: { segment: RingSegment }) {
  return <RingArc color={segment.color} length={segment.share} offset={segment.offset} />;
}

export function GalacticWarPanel({
  panelProps,
}: {
  /** Makes this the panel of the Play tab's Galactic War mode tab. */
  panelProps?: PlayModePanelProps;
} = {}) {
  const { t } = useTranslation();
  const state = useAppStore((store) => store.state.galacticWar);

  useEffect(() => {
    // Entering the surface is the only trigger: the gateway is a service
    // outside FAF, so it is asked when the user is actually looking at it.
    refresh();
  }, []);

  const status = state.status;
  const busy = isBusy(state);
  const running = status.type === "running";
  const target = installTarget(state);
  const needsUpdate = updateAvailable(state);

  const season = state.statistics?.season;
  const factions = state.statistics?.factions ?? [];
  const segments = ringSegments(factions);
  const statsFailed = state.statisticsStatus.type === "failed";
  const cycleAge = cycleAgeInDays(season?.startedAt ?? "");

  // While something is in flight the ring reports that instead of territory:
  // it is the only round thing on screen and the user is watching it anyway.
  const downloadShare =
    status.type === "downloading" && status.payload.totalBytes > 0
      ? Math.min(1, status.payload.downloadedBytes / status.payload.totalBytes)
      : null;
  const indeterminate =
    status.type === "installing" ||
    status.type === "checkingVersion" ||
    (status.type === "downloading" && downloadShare === null);

  const actionLabel = running
    ? t("lobby.galacticWar.action.running")
    : status.type === "downloading"
      ? t("lobby.galacticWar.action.downloading", {
          received: megabytes(status.payload.downloadedBytes),
        })
      : status.type === "installing"
        ? t("lobby.galacticWar.action.unpacking")
        : status.type === "checkingVersion"
          ? t("lobby.galacticWar.action.checking")
          : busy
            ? t("lobby.galacticWar.action.working")
            : !state.installedVersion
              ? t("lobby.galacticWar.action.install")
              : needsUpdate || state.belowMinimum
                ? t("lobby.galacticWar.action.update")
                : t("lobby.galacticWar.action.launch");

  // The cycle's name and age are its head; the counts are the strip under it.
  const cycleFacts: Fact[] = [
    { id: "players", label: t("lobby.galacticWar.stat.players"), value: season?.numPlayers ?? 0 },
    {
      id: "online",
      label: t("lobby.galacticWar.stat.online"),
      value: onlineCommanders(state.statistics),
      emphasis: true,
    },
    { id: "avatars", label: t("lobby.galacticWar.stat.avatars"), value: season?.numAvatars ?? 0 },
    { id: "battles", label: t("lobby.galacticWar.stat.battles"), value: season?.numBattles ?? 0 },
    { id: "planets", label: t("lobby.galacticWar.stat.planets"), value: season?.numPlanets ?? 0 },
    {
      id: "attacks",
      label: t("lobby.galacticWar.stat.activeAttacks"),
      value: season?.numActiveAttacks ?? 0,
    },
  ];

  const clientFacts: Fact[] = [
    {
      id: "installed",
      label: t("lobby.galacticWar.client.installed"),
      value: state.installedVersion ?? NO_VALUE,
      unknown: state.installedVersion === null,
    },
    {
      id: "available",
      label: t("lobby.galacticWar.client.available"),
      value: target || NO_VALUE,
      unknown: target === "",
    },
    {
      id: "minimum",
      label: t("lobby.galacticWar.client.minimum"),
      value: state.versions?.requiredVersion || NO_VALUE,
      unknown: !state.versions?.requiredVersion,
    },
  ];

  return (
    <div {...panelProps} className="gw-layout">
      <aside className="gw-column gw-column-info">
        <header className="gw-column-head">
          <h3>{t("lobby.galacticWar.client.title")}</h3>
          {/* Said in words in the head: a third of the column is too narrow
              for it as the strip's value. */}
          {state.installedVersion === null ? (
            <span className="gw-column-state">{t("lobby.galacticWar.notInstalled")}</span>
          ) : null}
        </header>
        <div className="gw-scroll">
          <section className="gw-section">
            <FactsStrip className="gw-client-facts" columns={3} groups={[{ facts: clientFacts }]} />
            {state.belowMinimum ? (
              <p className="gw-notice gw-notice-warn">{t("lobby.galacticWar.belowMinimum")}</p>
            ) : null}
            {/* Retry asks the gateway again, which is the one step every
                failure here shares: a failed version check is answered by it,
                and after a failed install or launch it clears the line and
                leaves the launch button to say what comes next. */}
            {status.type === "failed" ? (
              <StatusNotice
                tone="error"
                className="gw-failure"
                action={{ label: t("common.retry"), onClick: refresh }}
                detail={status.payload.reason}
              >
                {plainError(status.payload.reason)}
              </StatusNotice>
            ) : null}
          </section>

          <section className="gw-section gw-news">
            <h3 className="gw-section-title">{t("lobby.galacticWar.news.title")}</h3>
            {/* The gateway publishes no news or patch-notes endpoint, so there
                is deliberately nothing rendered here rather than filler. */}
            <p className="gw-muted">{t("lobby.galacticWar.news.empty")}</p>
          </section>
        </div>

        {/* One link to a line, icon first, as the vault panels list theirs. */}
        <div className="gw-links">
          {LINKS.map((link) => (
            <Button
              key={link.url}
              onClick={() => {
                void openHttpsUrl(link.url);
              }}
            >
              <Icon name="external" size={15} />
              {t(link.key)}
            </Button>
          ))}
        </div>
      </aside>

      <div className="gw-column gw-column-center">
        <section className="gw-board gw-world">
          <header className="gw-board-head">
            <div className="gw-board-heading">
              <h3>{t("lobby.galacticWar.cycle.title")}</h3>
              <p className="gw-cycle-name">{season?.name || NO_VALUE}</p>
            </div>
            {statsFailed ? (
              <span className="gw-offline">{t("lobby.galacticWar.statsUnavailable")}</span>
            ) : cycleAge !== null ? (
              <span className="gw-cycle-age">
                {t("lobby.galacticWar.cycle.age")}{" "}
                <strong>{t("lobby.galacticWar.cycle.days", { count: cycleAge })}</strong>
              </span>
            ) : null}
          </header>
          {season ? (
            <FactsStrip className="gw-cycle-facts" columns={3} groups={[{ facts: cycleFacts }]} />
          ) : (
            <p className="gw-muted gw-board-pad">{t("lobby.galacticWar.noSeason")}</p>
          )}
        </section>

        <div className="gw-launch">
          <svg className="gw-ring" viewBox="0 0 200 200" role="img">
            {/* The ring's meaning belongs to the ring, not to a caption under
                the button: there is no room for one that does not end up
                inside the circle. */}
            <title>
              {busy ? t("lobby.galacticWar.ringWorking") : t("lobby.galacticWar.ringCaption")}
            </title>
            <circle
              className="gw-ring-track"
              cx="100"
              cy="100"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="9"
            />
            {indeterminate ? (
              <RingArc className="gw-ring-busy" length={RING_BUSY_ARC / RING_CIRCUMFERENCE} round />
            ) : downloadShare !== null ? (
              <RingArc
                color="var(--color-accent)"
                length={downloadShare}
                round
              />
            ) : (
              segments.map((segment) => (
                <TerritoryArc key={segment.name} segment={segment} />
              ))
            )}
          </svg>
          <span className="gw-launch-bezel" />
          <button
            className="gw-launch-button"
            disabled={busy || running || (!canLaunch(state) && target === "")}
            onClick={play}
            type="button"
          >
            <span className="gw-launch-verb">{actionLabel}</span>
            <span className="gw-launch-name">{t("lobby.galacticWar.short")}</span>
          </button>
        </div>

        <section className="gw-board gw-factions-board">
          <header className="gw-factions-head">
            <h3>{t("lobby.galacticWar.factions.title")}</h3>
          </header>
          {segments.length > 0 ? (
            <ul className="gw-factions">
              {/* Rendered in the order the gateway sends, under the names it
                  sends, with the glyph resolved from the name: faction ids are
                  numbered differently by the spec and the running server. */}
              {factions.map((faction, index) => {
                const segment = segments[index];
                const factionName = galacticWarFactionLabel(
                  faction.name || faction.longName || "",
                  faction.longName || faction.name || "",
                );
                const figures: Array<{ key: string; label: string; value: number }> = [
                  {
                    key: "avatars",
                    label: t("lobby.galacticWar.stat.avatars"),
                    value: faction.numAvatars ?? 0,
                  },
                  {
                    key: "alive",
                    label: t("lobby.galacticWar.stat.aliveAvatars"),
                    value: faction.numAliveAvatars ?? 0,
                  },
                  {
                    key: "online",
                    label: t("lobby.galacticWar.stat.online"),
                    value: faction.numOnlineAvatars ?? 0,
                  },
                ];
                return (
                  <li
                    className="gw-faction"
                    key={`${faction.name}-${index}`}
                    style={{ "--gw-faction-color": segment.color } as CSSProperties}
                  >
                    {/* The emblem faint in the top right corner, whole: the
                        faction's mark, standing behind the head and the share. */}
                    <FactionIcon
                      faction={segment.faction}
                      size={76}
                      className="gw-faction-emblem"
                      aria-hidden="true"
                    />

                    <div className="gw-faction-head">
                      <span className="gw-faction-name">{factionName}</span>
                      <span className="gw-faction-planets">
                        {faction.numPlanets ?? 0} / {planetsTotal(segments)}{" "}
                        {t("lobby.galacticWar.stat.planets")}
                      </span>
                    </div>

                    {/* Territory leads the card: it is the one figure that says
                        who is winning. The field under it is the galaxy, a dot
                        per planet, lit where this faction holds it. */}
                    <div className="gw-faction-territory">
                      <p className="gw-faction-share">
                        <span className="gw-faction-share-value">
                          {Math.round(segment.share * 100)}%
                        </span>
                        <span className="gw-faction-share-label">
                          {t("lobby.galacticWar.faction.territory")}
                        </span>
                      </p>
                      <TerritoryShare segments={segments} own={index} />
                    </div>

                    <dl className="gw-faction-figures">
                      {figures.map((figure) => (
                        <div key={figure.key}>
                          <dt>{figure.label}</dt>
                          <dd>{figure.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="gw-muted">{t("lobby.galacticWar.noFactions")}</p>
          )}
        </section>
      </div>

      <aside className="gw-column gw-column-how">
        <header className="gw-column-head">
          <h3>{t("lobby.galacticWar.how.title")}</h3>
        </header>
        <div className="gw-scroll">
          {HOW_IT_WORKS.map((entry) => (
            <section className="gw-section" key={entry.title}>
              <h3 className="gw-section-title">{t(entry.title)}</h3>
              <p>{t(entry.body)}</p>
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}
