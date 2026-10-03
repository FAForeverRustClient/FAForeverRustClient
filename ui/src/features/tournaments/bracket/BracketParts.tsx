// The pieces of the elimination bracket the website draws around the cards:
// the early-stop notice, each round's map block with its two dialogs, and the
// preview of the bracket before it is drawn.

import { useState, type CSSProperties } from "react";
import { Button } from "../../../design-system/Button";
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
 * `mapsLine`. With vetoes on, the pool the round really uses, where it came
 * from, and a way for an organiser to change it; with vetoes off, the maps
 * pinned to each game, and a way to set them.
 */
export function RoundMapBlock(props: RoundMapBlockProps) {
  const { event, bracket, round } = props;
  const { t } = useTranslation();
  const [open, setOpen] = useState<"pool" | "pick" | "maps" | null>(null);
  if (event.imported) return null;
  const organiser = event.viewer.organiser;
  const key = roundKeyOf(bracket, round);

  if (event.veto.enabled) {
    const resolved = poolForRoundOf(event, bracket, round);
    if (!organiser && resolved === null) return null;
    const pool = resolved?.pool ?? null;
    return (
      <div className="tournament-mapblock">
        <div className="tournament-mapblock-head">
          <span className="mono">{t("tournaments.mapblock.pool")}</span>
          {organiser && props.onAssignPool !== undefined && (
            <button type="button" className="tournament-link-button" onClick={() => setOpen("pick")}>
              {t("tournaments.mapblock.change")}
            </button>
          )}
        </div>
        {pool === null ? (
          <span className="muted">{t("tournaments.mapblock.noPools")}</span>
        ) : (
          <>
            <span>
              {pool.name}{" "}
              {resolved?.source === "semis" && (
                <span className="muted" title={t("tournaments.mapblock.semisHint")}>
                  {t("tournaments.mapblock.semis")}
                </span>
              )}
              {resolved?.source === "default" && (
                <span className="muted" title={t("tournaments.mapblock.defaultHint")}>
                  {t("tournaments.mapblock.default")}
                </span>
              )}
            </span>
            {pool.mapIds.length > 3 ? (
              <button type="button" className="tournament-link-button" onClick={() => setOpen("pool")}>
                {t("tournaments.mapblock.showPool", { count: pool.mapIds.length })}
              </button>
            ) : (
              <button type="button" className="tournament-link-button muted" onClick={() => setOpen("pool")}>
                {pool.mapIds.map((id) => event.mapDb.find((held) => held.id === id)?.name ?? id).join(", ")}
              </button>
            )}
          </>
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
            title={roundName(bracket, round, t)}
            bestOf={props.bestOf}
            current={event.poolAssign.find((held) => held.round === key)?.poolId ?? ""}
            onSave={(poolId) => {
              props.onAssignPool?.(key, poolId);
              setOpen(null);
            }}
            onClose={() => setOpen(null)}
          />
        )}
      </div>
    );
  }

  const pinned = event.roundMaps.find((held) => held.round === key)?.mapIds ?? [];
  const fallback =
    bracket === "thirdPlace" && pinned.length === 0
      ? (event.roundMaps.find((held) => held.round === roundKeyOf("winners", round - 1))?.mapIds ?? [])
      : pinned;
  if (fallback.length === 0 && !organiser) return null;
  return (
    <div className="tournament-mapblock">
      <div className="tournament-mapblock-head">
        <span className="mono">{t("tournaments.mapblock.pool")}</span>
        {organiser && (
          <button type="button" className="tournament-link-button" onClick={() => setOpen("maps")}>
            {t("tournaments.mapblock.edit")}
          </button>
        )}
      </div>
      {fallback.length === 0 ? (
        <span className="muted">{t("tournaments.mapblock.noMaps")}</span>
      ) : (
        fallback.map((id, index) => (
          <span key={`${id}-${index}`}>
            <span className="muted mono">{t("tournaments.mapblock.game", { number: index + 1 })}</span>{" "}
            {event.mapDb.find((held) => held.id === id)?.name ?? id}
          </span>
        ))
      )}
      {open === "maps" && (
        <RoundMapsDialog
          event={event}
          title={roundName(bracket, round, t)}
          bestOf={props.bestOf}
          current={pinned}
          onSave={(mapIds) => {
            props.onAdmin({ type: "setMaps", payload: { bracket, round, mapIds } });
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
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
  const { t } = useTranslation();
  if (card === null) return <div className="tournament-match is-phantom" aria-hidden />;
  const side = (slot: PreviewCard["one"]) => (
    <span className={slot.real ? "tournament-match-side" : "tournament-match-side is-tbd"}>
      <span className="tournament-match-seed mono">{slot.seed ?? ""}</span>
      <span className="tournament-match-who">{slot.text}</span>
      <span className="tournament-match-score mono" />
    </span>
  );
  return (
    <div className={["surface", "tournament-match", "is-preview", ...arms.map((arm) => `is-${arm}`)].join(" ")} title={`${card.tag} · ${t("tournaments.matches.bestOf", { count: card.bestOf })}`}>
      <div className="tournament-match-pair">
        {side(card.one)}
        {side(card.two)}
      </div>
      <div className="tournament-match-actions">
        <span className="muted mono">{`BO${card.bestOf}`}</span>
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
      <div className="tournament-bracket-side">
        {heading !== null && <h4>{heading}</h4>}
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
                    <span className="muted mono">{`Bo${column.bestOf}`}</span>
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
                {preview.third !== null && column.bracket === "winners" && index === shown.length - 1 && (
                  <div className="tournament-third-place">
                    <div className="tournament-round-head">
                      <h5>{t("tournaments.bracket.colThirdPlace")}</h5>
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
      </div>
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
