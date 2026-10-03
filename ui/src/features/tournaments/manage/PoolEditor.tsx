// Map pools, and the ban/pick order a series is played through.
//
// The order is the awkward part, and it is awkward on the service's side too:
// every map but one is consumed by a step, and every pick is a game, so a Bo3
// wants four maps and three steps of which two are picks. The service refuses
// anything else and answers with the numbers it wanted, which is a poor way to
// find out. `poolRejection` is the twin of that rule, so the refusal is shown
// against the form rather than after a round trip.
//
// Steps are added and removed rather than typed as a sequence, because the two
// counts have to move together and a free-form editor makes it easy to leave
// them disagreeing.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import type { MapPool, PoolDraft, PoolStep, Tourney, TourneyAdmin } from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { poolRejection, type PoolRejection } from "../../../shared/rules/tourneyRules";
import { formatMoment } from "../tourneyPresentation";
import { CopyOrderDialog } from "./CopyOrderDialog";

/** Unix seconds as a `datetime-local` value, in local time; empty for none. */
export function localInput(seconds: number | null): string {
  if (seconds === null) return "";
  const moment = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}T${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
}

/** A `datetime-local` value as Unix seconds, or null when empty or unreadable. */
export function fromLocalInput(value: string): number | null {
  if (value === "") return null;
  const millis = new Date(value).getTime();
  return Number.isNaN(millis) ? null : Math.floor(millis / 1000);
}

/** The series lengths the service accepts. */
const BEST_OF = [1, 3, 5, 7];

const BLANK: PoolDraft = { id: "", name: "", mapIds: [], bestOf: 3, sequence: [], publishAt: null };

interface PoolEditorProps {
  event: Tourney;
  busy: boolean;
  onSave: (pool: PoolDraft) => void;
  onPublish: (poolId: string, published: boolean) => void;
  onDelete: (poolId: string) => void;
  /** Copying one pool's order onto others. */
  onAdmin: (change: TourneyAdmin) => void;
}

export function PoolEditor(props: PoolEditorProps) {
  const { event, busy } = props;
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PoolDraft | null>(null);
  /** The pool whose order is being copied, if any. */
  const [copying, setCopying] = useState<MapPool | null>(null);

  const nameOf = (mapId: string) =>
    event.mapDb.find((held) => held.id === mapId)?.name ?? mapId;

  /** The refusal as a sentence, with the numbers the service would have named. */
  const refusalOf = (rejection: PoolRejection): string => {
    if (typeof rejection === "string") {
      const labels: Record<"nameRequired" | "mapsRequired", MessageKey> = {
        nameRequired: "tournaments.pools.nameRequired",
        mapsRequired: "tournaments.pools.mapsRequired",
      };
      return t(labels[rejection]);
    }
    if ("stepCountWrong" in rejection) {
      return t("tournaments.pools.stepCountWrong", rejection.stepCountWrong);
    }
    return t("tournaments.pools.pickCountWrong", rejection.pickCountWrong);
  };

  const editor = (held: PoolDraft) => {
    const rejection = poolRejection(held);
    const toggleMap = (mapId: string) =>
      setDraft((current) => {
        if (current === null) return current;
        const chosen = current.mapIds.includes(mapId)
          ? current.mapIds.filter((id) => id !== mapId)
          : [...current.mapIds, mapId];
        return { ...current, mapIds: chosen };
      });
    const setStep = (at: number, step: PoolStep) =>
      setDraft((current) =>
        current === null
          ? current
          : { ...current, sequence: current.sequence.map((old, index) => (index === at ? step : old)) },
      );

    return (
      <form
        className="tournament-pool-editor surface"
        onSubmit={(submitted) => {
          submitted.preventDefault();
          if (rejection !== null) return;
          props.onSave(held);
          setDraft(null);
        }}
      >
        <div className="tournament-form-row">
          <label className="tournament-field">
            <span>{t("tournaments.pools.name")}</span>
            <input
              value={held.name}
              autoFocus
              onChange={(changed) =>
                setDraft((current) =>
                  current === null ? current : { ...current, name: changed.target.value },
                )
              }
            />
          </label>
          <label className="tournament-field">
            <span>{t("tournaments.pools.bestOf")}</span>
            <select
              value={held.bestOf ?? 3}
              onChange={(changed) =>
                setDraft((current) =>
                  current === null ? current : { ...current, bestOf: Number(changed.target.value) },
                )
              }
            >
              {BEST_OF.map((count) => (
                <option key={count} value={count}>
                  {t("tournaments.pools.bo", { count })}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="tournament-pool-maps-pick">
          <legend>{t("tournaments.pools.maps")}</legend>
          {event.mapDb.length === 0 && <p className="muted">{t("tournaments.pools.noMapsYet")}</p>}
          {event.mapDb.map((map) => (
            <label className="tournament-checkbox" key={map.id}>
              <input
                type="checkbox"
                checked={held.mapIds.includes(map.id)}
                onChange={() => toggleMap(map.id)}
              />
              <span>{map.name}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="tournament-pool-steps">
          <legend>{t("tournaments.pools.order")}</legend>
          <p className="muted">{t("tournaments.pools.orderHint")}</p>
          {held.sequence.map((step, index) => (
            // Position is the identity: steps have no id, and reordering means
            // rewriting the list anyway.
            <div className="tournament-pool-step" key={index}>
              <span className="mono">{index + 1}</span>
              <select
                value={step.team}
                onChange={(changed) =>
                  setStep(index, { ...step, team: changed.target.value as PoolStep["team"] })
                }
              >
                <option value="a">{t("tournaments.pools.teamA")}</option>
                <option value="b">{t("tournaments.pools.teamB")}</option>
              </select>
              <select
                value={step.action}
                onChange={(changed) =>
                  setStep(index, { ...step, action: changed.target.value as PoolStep["action"] })
                }
              >
                <option value="ban">{t("tournaments.pools.ban")}</option>
                <option value="pick">{t("tournaments.pools.pick")}</option>
              </select>
              <Button
                type="button"
                onClick={() =>
                  setDraft((current) =>
                    current === null
                      ? current
                      : { ...current, sequence: current.sequence.filter((_, at) => at !== index) },
                  )
                }
              >
                {t("tournaments.pools.removeStep")}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            onClick={() =>
              setDraft((current) =>
                current === null
                  ? current
                  : { ...current, sequence: [...current.sequence, { action: "ban", team: "a" }] },
              )
            }
          >
            <Icon name="plus" size={16} /> {t("tournaments.pools.addStep")}
          </Button>
        </fieldset>

        {/* A reveal at a set moment: the service publishes the pool and every
            map in it on the first read after that time. Pointless once the
            pool is out, and said so rather than hidden. */}
        <label className="tournament-field">
          <span>
            {t("tournaments.pools.publishAt")} <span className="muted">{t("tournaments.pools.publishAtHint")}</span>
          </span>
          <input
            type="datetime-local"
            value={localInput(held.publishAt ?? null)}
            onChange={(changed) =>
              setDraft((current) =>
                current === null ? current : { ...current, publishAt: fromLocalInput(changed.target.value) },
              )
            }
          />
          <small className="muted">
            {t(
              event.mapPools.some((pool) => pool.id === held.id && pool.published)
                ? "tournaments.pools.publishAtPublished"
                : "tournaments.pools.publishAtExplain",
            )}
          </small>
        </label>

        {rejection !== null && <p className="tournament-refusal">{refusalOf(rejection)}</p>}

        <div className="tournament-detail-actions">
          <Button type="submit" variant="primary" disabled={busy || rejection !== null}>
            {t("tournaments.pools.save")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => setDraft(null)}>
            {t("tournaments.pools.cancel")}
          </Button>
        </div>
      </form>
    );
  };

  const asDraft = (pool: MapPool): PoolDraft => ({
    id: pool.id,
    name: pool.name,
    mapIds: [...pool.mapIds],
    bestOf: pool.bestOf,
    sequence: [...pool.sequence],
    publishAt: pool.publishAt,
  });

  return (
    <section className="tournament-pool-admin">
      <h5>{t("tournaments.pools.heading")}</h5>

      {event.mapPools.length === 0 && <p className="muted">{t("tournaments.pools.noneYet")}</p>}

      <ul className="tournament-pool-admin-list">
        {event.mapPools.map((pool) => {
          return (
            <li className="surface tournament-pool-admin-row" key={pool.id}>
              <div className="tournament-map-names">
                <span>{pool.name}</span>
                <span className="muted">
                  {t("tournaments.pools.summary", {
                    maps: pool.mapIds.length,
                    bo: pool.bestOf ?? 1,
                  })}
                </span>
                {pool.mapIds.length > 0 && (
                  <span className="muted">{pool.mapIds.map(nameOf).join(", ")}</span>
                )}
              </div>
              {!pool.published && (
                <span className="tournament-hidden-mark" title={t("tournaments.pools.hiddenHint")}>
                  {t("tournaments.maps.hidden")}
                </span>
              )}
              {!pool.published && pool.publishAt !== null && (
                <span className="tournament-hidden-mark" title={t("tournaments.pools.scheduledHint")}>
                  {t("tournaments.pools.scheduled", { when: formatMoment(pool.publishAt, "") })}
                </span>
              )}
              <div className="tournament-detail-actions">
                <Button
                  disabled={busy}
                  onClick={() => props.onPublish(pool.id, !pool.published)}
                >
                  {t(pool.published ? "tournaments.maps.hide" : "tournaments.maps.publish")}
                </Button>
                <Button disabled={busy} onClick={() => setDraft(asDraft(pool))}>
                  {t("tournaments.maps.edit")}
                </Button>
                {/* Only a complete order can be copied: its length is fixed by
                    the map count, so it goes to pools of the same size. */}
                {pool.mapIds.length > 1 && pool.sequence.length === pool.mapIds.length - 1 && (
                  <Button disabled={busy} onClick={() => setCopying(pool)}>
                    {t("tournaments.pools.copyOrder")}
                  </Button>
                )}
                <Button disabled={busy} onClick={() => props.onDelete(pool.id)}>
                  {t("tournaments.maps.delete")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {copying !== null && (
        <CopyOrderDialog
          source={copying}
          pools={event.mapPools}
          busy={busy}
          onCopy={(targets) => {
            props.onAdmin({ type: "copyPoolOrder", payload: { sourceId: copying.id, targets } });
            setCopying(null);
          }}
          onCancel={() => setCopying(null)}
        />
      )}

      {draft === null ? (
        <Button disabled={busy} onClick={() => setDraft(BLANK)}>
          <Icon name="plus" size={16} /> {t("tournaments.pools.add")}
        </Button>
      ) : (
        editor(draft)
      )}
    </section>
  );
}
