// The pieces of the elimination bracket the website draws around the cards:
// the early-stop notice, each round's map block with its two dialogs, and the
// preview of the bracket before it is drawn.

import { useState, type CSSProperties } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { Modal } from "../../../design-system/Modal";
import type { BracketSide, MapPool, Tourney, TourneyAdmin, VaultMap } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { roundKeyOf } from "../../../shared/rules/tourneyRules";
import { stopAtRemaining } from "../overviewPresentation";
import { PoolPanel } from "./RoundPool";
import { poolForRoundOf } from "./poolPresentation";
import type { BracketPreview, PreviewCard, PreviewColumn } from "./bracketPresentation";

/** The series lengths the service accepts. */
const BEST_OF = [1, 3, 5, 7];

/**
 * A declared early stop, said on the bracket itself: the website's
 * `drawStopNotice`. Without it the bracket draws a final nobody will play.
 */
export function StopNotice({ event }: { event: Tourney }) {
  const { t } = useTranslation();
  if (event.stopAtAlive <= 0) return null;
  const finish = event.earlyFinish;
  if (finish !== null) {
    return (
      <section className="surface tournament-stop-notice is-done">
        <span className="tournament-stop-head mono">{t("tournaments.stop.ended")}</span>
        <p>
          {finish.automatic
            ? t("tournaments.stop.stoppedAuto", { count: finish.alive, names: finish.names.join(", ") })
            : t("tournaments.stop.stoppedBy", {
                who: finish.by || t("tournaments.stop.anOrganiser"),
                count: finish.alive,
                names: finish.names.join(", "),
              })}
        </p>
        {finish.target > 0 && finish.alive < finish.target && (
          <p className="muted">{t("tournaments.stop.overshot", { target: finish.target })}</p>
        )}
        <p className="muted">{t("tournaments.stop.greyed")}</p>
      </section>
    );
  }
  const left = stopAtRemaining(event);
  return (
    <section className="surface tournament-stop-notice">
      <span className="tournament-stop-head mono">{t("tournaments.stop.endsEarly")}</span>
      <p>{t("tournaments.overview.stopAtLine", { count: event.stopAtAlive })}</p>
      {left !== null && (
        <p className="tournament-stop-count">
          {left === 0 ? t("tournaments.stop.nextEnds") : t("tournaments.overview.stopAtToGo", { count: left })}
        </p>
      )}
    </section>
  );
}

/** A round's name as a pool dialog titles it. */
function roundName(bracket: BracketSide, round: number, t: ReturnType<typeof useTranslation>["t"]): string {
  if (bracket === "grandFinal") return t("tournaments.bracket.grandFinal");
  if (bracket === "thirdPlace") return t("tournaments.bracket.thirdPlace");
  if (bracket === "losers") return t("tournaments.bracket.colLbRound", { round });
  return t("tournaments.bracket.round", { round });
}

interface RoundMapBlockProps {
  event: Tourney;
  bracket: BracketSide;
  round: number;
  vault: VaultMap[];
  assetBase: string;
  /** The round's length, for the map dialog and the pool warning. */
  bestOf: number;
  onAdmin: (change: TourneyAdmin) => void;
  onAssignPool?: (key: string, poolId: string) => void;
}

/**
 * The maps a round is played on, in its column header: the website's
 * `mapsLine`. With vetoes on, the pool the round really uses; with vetoes off,
 * the maps pinned to each game. Either way an organiser can change it.
 *
 * One small button rather than the list itself. The list made every header a
 * different height, two to five lines of map names squeezed beside the round's
 * name, and the header strip is what a reader's eye runs along to find a
 * round. The button names the pool, or how many maps there are, and opens
 * them; the pool's grid of pictures and the per-game list are a click away.
 */
export function RoundMapBlock(props: RoundMapBlockProps) {
  const { event, bracket, round } = props;
  const { t } = useTranslation();
  const [open, setOpen] = useState<"pool" | "pick" | "maps" | "list" | null>(null);
  if (event.imported) return null;
  const organiser = event.viewer.organiser;
  const key = roundKeyOf(bracket, round);
  const title = roundName(bracket, round, t);
  const heading = t("tournaments.mapblock.mapsTitle", { round: title });

  if (event.veto.enabled) {
    const resolved = poolForRoundOf(event, bracket, round);
    if (!organiser && resolved === null) return null;
    const pool = resolved?.pool ?? null;
    // Where the pool came from, when it was not assigned to this round: the
    // first pool by default, or the semi-finals' for a 3rd place match.
    const source =
      resolved?.source === "semis"
        ? t("tournaments.mapblock.semisHint")
        : resolved?.source === "default"
          ? t("tournaments.mapblock.defaultHint")
          : "";
    return (
      <span className="tournament-round-maps">
        <Button
          className="tournament-round-button"
          disabled={pool === null}
          title={pool === null ? t("tournaments.mapblock.noPools") : [heading, source].filter(Boolean).join("\n")}
          onClick={() => setOpen("pool")}
        >
          <Icon name="maps" size={14} />
          <span>{pool === null ? t("tournaments.mapblock.noMaps") : pool.name}</span>
        </Button>
        {organiser && props.onAssignPool !== undefined && (
          <Button
            className="tournament-round-button is-icon"
            title={t("tournaments.mapblock.change")}
            aria-label={t("tournaments.mapblock.change")}
            onClick={() => setOpen("pick")}
          >
            <Icon name="edit" size={14} />
          </Button>
        )}
        {open === "pool" && pool !== null && (
          <PoolPanel
            event={event}
            vault={props.vault}
            assetBase={props.assetBase}
            roundKey={key}
            pool={pool}
            onClose={() => setOpen(null)}
          />
        )}
        {open === "pick" && props.onAssignPool !== undefined && (
          <PoolPicker
            event={event}
            title={title}
            bestOf={props.bestOf}
            current={event.poolAssign.find((held) => held.round === key)?.poolId ?? ""}
            onSave={(poolId) => {
              props.onAssignPool?.(key, poolId);
              setOpen(null);
            }}
            onClose={() => setOpen(null)}
          />
        )}
      </span>
    );
  }

  const pinned = event.roundMaps.find((held) => held.round === key)?.mapIds ?? [];
  const fallback =
    bracket === "thirdPlace" && pinned.length === 0
      ? (event.roundMaps.find((held) => held.round === roundKeyOf("winners", round - 1))?.mapIds ?? [])
      : pinned;
  if (fallback.length === 0 && !organiser) return null;
  const mapName = (id: string) => event.mapDb.find((held) => held.id === id)?.name ?? id;
  return (
    <span className="tournament-round-maps">
      <Button
        className="tournament-round-button"
        disabled={fallback.length === 0}
        title={fallback.length === 0 ? t("tournaments.mapblock.noMaps") : heading}
        onClick={() => setOpen("list")}
      >
        <Icon name="maps" size={14} />
        <span>
          {fallback.length === 0
            ? t("tournaments.mapblock.noMaps")
            : t("tournaments.mapblock.mapCount", { count: fallback.length })}
        </span>
      </Button>
      {organiser && (
        <Button
          className="tournament-round-button is-icon"
          title={t("tournaments.mapblock.edit")}
          aria-label={t("tournaments.mapblock.edit")}
          onClick={() => setOpen("maps")}
        >
          <Icon name="edit" size={14} />
        </Button>
      )}
      {open === "list" && (
        <Modal onClose={() => setOpen(null)} ariaLabel={heading} className="tournament-pool-modal">
          <h4>{heading}</h4>
          <ol className="tournament-round-map-list">
            {fallback.map((id, index) => (
              <li key={`${id}-${index}`}>
                <span className="muted">{t("tournaments.mapblock.gameLabel", { number: index + 1 })}</span>
                <span>{mapName(id)}</span>
              </li>
            ))}
          </ol>
          <div className="tournament-form-actions">
            {organiser && <Button onClick={() => setOpen("maps")}>{t("tournaments.mapblock.edit")}</Button>}
            <Button variant="primary" onClick={() => setOpen(null)}>
              {t("common.close")}
            </Button>
          </div>
        </Modal>
      )}
      {open === "maps" && (
        <RoundMapsDialog
          event={event}
          title={title}
          bestOf={props.bestOf}
          current={pinned}
          onSave={(mapIds) => {
            props.onAdmin({ type: "setMaps", payload: { bracket, round, mapIds } });
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </span>
  );
}

/** Which pool a round uses: the website's `pickPoolForRound`. */
function PoolPicker({
  event,
  title,
  bestOf,
  current,
  onSave,
  onClose,
}: {
  event: Tourney;
  title: string;
  bestOf: number;
  current: string;
  onSave: (poolId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState(current);
  const pools: MapPool[] = event.mapPools;
  return (
    <Modal onClose={onClose} ariaLabel={title} className="tournament-pool-modal">
      <h4>{t("tournaments.mapblock.pickTitle", { round: title })}</h4>
      {pools.length === 0 ? (
        <p className="muted">{t("tournaments.mapblock.noPoolsYet")}</p>
      ) : (
        <>
          <p className="muted">{t("tournaments.mapblock.pickHint", { bo: bestOf })}</p>
          <div className="tournament-pick-rows">
            {pools.map((pool) => (
              <button
                type="button"
                key={pool.id}
                className={chosen === pool.id ? "tournament-pick-row is-on" : "tournament-pick-row"}
                aria-pressed={chosen === pool.id}
                onClick={() => setChosen(pool.id)}
              >
                <span>{pool.name}</span>
                <span className="muted">
                  {t("tournaments.pools.summary", { maps: pool.mapIds.length, bo: pool.bestOf ?? 1 })}
                </span>
                {(pool.bestOf ?? 1) !== bestOf && (
                  <span className="tournament-warning">{t("tournaments.mapblock.notBo", { bo: bestOf })}</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="tournament-form-actions">
        <Button onClick={onClose}>{t("tournaments.pools.cancel")}</Button>
        {pools.length > 0 && (
          <>
            <Button onClick={() => onSave("")}>{t("tournaments.mapblock.useDefault")}</Button>
            <Button variant="primary" disabled={chosen === ""} onClick={() => onSave(chosen)}>
              {t("tournaments.pools.save")}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

/** The maps pinned to a round, one per game: the website's `editMaps`. */
function RoundMapsDialog({
  event,
  title,
  bestOf,
  current,
  onSave,
  onClose,
}: {
  event: Tourney;
  title: string;
  bestOf: number;
  current: string[];
  onSave: (mapIds: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const count = Math.max(bestOf, current.length, 1);
  const [picked, setPicked] = useState<string[]>(() =>
    Array.from({ length: count }, (_, index) => current[index] ?? ""),
  );
  return (
    <Modal onClose={onClose} ariaLabel={title} className="tournament-pool-modal">
      <h4>{t("tournaments.mapblock.mapsTitle", { round: title })}</h4>
      {event.mapDb.length === 0 ? (
        <p className="muted">{t("tournaments.mapblock.noDatabase")}</p>
      ) : (
        <>
          <p className="muted">{t("tournaments.mapblock.mapsHint", { bo: bestOf })}</p>
          {picked.map((mapId, index) => (
            <label className="tournament-field" key={index}>
              <span>{t("tournaments.mapblock.gameLabel", { number: index + 1 })}</span>
              <select
                value={mapId}
                onChange={(changed) =>
                  setPicked((held) => held.map((old, at) => (at === index ? changed.target.value : old)))
                }
              >
                <option value="">{t("tournaments.mapblock.none")}</option>
                {event.mapDb.map((map) => (
                  <option key={map.id} value={map.id}>
                    {map.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </>
      )}
      <div className="tournament-form-actions">
        <Button onClick={onClose}>{t("tournaments.pools.cancel")}</Button>
        {event.mapDb.length > 0 && (
          <Button variant="primary" onClick={() => onSave(picked.filter((id) => id !== "").slice(0, 9))}>
            {t("tournaments.mapblock.saveMaps")}
          </Button>
        )}
      </div>
    </Modal>
  );
}

/** One card of the preview: never clickable, drawn dashed. */
function PreviewMatch({ card, arms = [] }: { card: PreviewCard | null; arms?: string[] }) {
  if (card === null) return <div className="tournament-match is-phantom" aria-hidden />;
  const side = (slot: PreviewCard["one"]) => (
    <span className={slot.real ? "tournament-match-side" : "tournament-match-side is-tbd"}>
      <span className="tournament-match-seed mono">{slot.seed ?? ""}</span>
      <span className="tournament-match-who">{slot.text}</span>
      <span className="tournament-match-score mono" />
    </span>
  );
  return (
    <div className={["tournament-match", "is-preview", ...arms.map((arm) => `is-${arm}`)].join(" ")}>
      <div className="tournament-match-pair">
        {side(card.one)}
        {side(card.two)}
      </div>
      <div className="tournament-match-foot">
        <span className="tournament-match-status">
          <span className="tournament-match-label mono">{card.tag}</span>
        </span>
      </div>
    </div>
  );
}

interface PreviewProps {
  event: Tourney;
  preview: BracketPreview;
  vault: VaultMap[];
  assetBase: string;
  onAdmin: (change: TourneyAdmin) => void;
  onAssignPool?: (key: string, poolId: string) => void;
}

/**
 * The bracket before it exists: the website's `drawBracketPreview`. The same
 * columns and connectors the drawn bracket will have, seeds where teams are
 * not placed yet, and an organiser's best-of per round where the event has
 * one per round.
 */
export function PreviewBracket({ event, preview, vault, assetBase, onAdmin, onAssignPool }: PreviewProps) {
  const { t } = useTranslation();
  const perRound = event.viewer.organiser && event.perRoundBo;
  const section = (columns: PreviewColumn[], heading: string | null) => {
    const shown = columns.filter((column) => column.cards.some((card) => card !== null));
    if (shown.length === 0) return null;
    const first = shown[0].cards.length;
    return (
      <section className="tournament-bracket-side">
        {heading !== null && (
          <header className="tournament-bracket-side-head">
            <h4>{heading}</h4>
          </header>
        )}
        <div className="tournament-bracket-columns">
          {shown.map((column, index) => {
            const count = column.cards.length;
            const previous = index === 0 ? 0 : shown[index - 1].cards.length;
            const grandFinal = column.bracket === "grandFinal";
            const link = index === 0 || grandFinal ? "none" : previous === count * 2 ? "bracket" : previous === count ? "straight" : "none";
            const pitch = Math.max(1, first / count);
            const side: BracketSide = column.bracket;
            return (
              <div className={`tournament-round is-${link}`} key={`${column.bracket}-${column.round}`}>
                <div className="tournament-round-head">
                  <h5>{column.label}</h5>
                  {perRound ? (
                    <select
                      className="tournament-round-bo"
                      value={column.bestOf}
                      aria-label={t("tournaments.bracket.roundBestOf")}
                      onChange={(changed) =>
                        onAdmin({
                          type: "planRoundBestOf",
                          payload: { list: column.list, index: column.index, bestOf: Number(changed.target.value) },
                        })
                      }
                    >
                      {BEST_OF.map((bo) => (
                        <option key={bo} value={bo}>{`Bo${bo}`}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="tournament-round-bo-text">{`Bo${column.bestOf}`}</span>
                  )}
                  <RoundMapBlock
                    event={event}
                    bracket={side}
                    round={column.round}
                    vault={vault}
                    assetBase={assetBase}
                    bestOf={column.bestOf}
                    onAdmin={onAdmin}
                    onAssignPool={onAssignPool}
                  />
                </div>
                <div className="tournament-round-matches" style={{ "--pitch": pitch } as CSSProperties}>
                  {column.cards.map((card, at) => {
                    // A feeder that is a bye leaves its arm with nothing at
                    // the end, as on the drawn bracket.
                    const before = index === 0 ? null : shown[index - 1].cards;
                    const arms: string[] = [];
                    if (before !== null && link === "bracket") {
                      if (before[at * 2] === null) arms.push("no-top");
                      if (before[at * 2 + 1] === null) arms.push("no-bottom");
                    }
                    if (before !== null && link === "straight" && before[at] === null) arms.push("no-stub");
                    return <PreviewMatch key={at} card={card} arms={arms} />;
                  })}
                </div>
                {/* The 3rd place match under the final, as on the drawn
                    bracket. */}
                {preview.third !== null && column.bracket === "winners" && index === shown.length - 1 && (
                  <div className="tournament-third-place" style={{ "--pitch": pitch } as CSSProperties}>
                    <div className="tournament-round-head">
                      <h5>{t("tournaments.bracket.colThirdPlace")}</h5>
                      <span className="tournament-round-bo-text">
                        {t("tournaments.matches.bestOf", { count: preview.third.bestOf })}
                      </span>
                    </div>
                    <div className="tournament-round-matches">
                      <PreviewMatch card={preview.third} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    );
  };
  const capNote =
    event.maxTeams > 0 ? t("tournaments.preview.capped", { count: event.maxTeams }) : t("tournaments.preview.uncapped");
  return (
    <div className="tournament-bracket">
      <section className="surface tournament-preview-head">
        <h4>{t("tournaments.preview.title")}</h4>
        <p className="muted">{t("tournaments.preview.note", { cap: capNote })}</p>
      </section>
      {preview.teams < 2 ? (
        <p className="muted">{t("tournaments.preview.notEnough")}</p>
      ) : (
        <>
          {section(preview.winners, event.bracketKind === "double" ? t("tournaments.bracket.winners") : null)}
          {section(preview.losers, t("tournaments.bracket.losers"))}
        </>
      )}
    </div>
  );
}
