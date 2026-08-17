// Binding a map pool to a round.
//
// The one organiser task this client does better than the website, and the
// reason it is here at all: picking maps is a search through FAF's vault with
// previews, which the client already has and a web form cannot match. Setting
// the tournament up, its format, its rating gates, its series, stays on the
// website behind a link.
//
// The pool's maps are the tournament's own records, which carry a name an
// organiser typed by hand. `matchVaultMap` is the twin of the Rust resolver
// that turns `Setons Clutch`, `scmp_009` and `SCMP_009.v0001` into the same
// vault entry, so a preview appears without anyone maintaining a lookup table.

import { Button } from "../../design-system/Button";
import type { MapPool, Tourney, TourneyMap, VaultMap } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { BRACKET_LABELS } from "./tourneyPresentation";

/** Twin of `faf_domain::state::map_key`: letters and digits, folded. */
export function mapKey(name: string): string {
  return [...name].filter((character) => /\p{L}|\p{N}/u.test(character)).join("").toLowerCase();
}

/** Strip a version suffix like `.v0001` before comparing folder names. */
function withoutVersion(folder: string): string {
  return folder.split(".v")[0];
}

/**
 * The vault map a tournament map refers to, or null when it was never uploaded.
 *
 * Twin of `match_vault_map`: the display name first, the folder name second, so
 * both `Seton's Clutch` and `scmp_009` resolve to the same entry.
 */
export function matchVaultMap(tourneyMap: TourneyMap, vault: VaultMap[]): VaultMap | null {
  const wanted = mapKey(tourneyMap.name);
  if (wanted === "") return null;
  const byName = vault.find((candidate) => mapKey(candidate.displayName) === wanted);
  if (byName !== undefined) return byName;
  // The version has to come off both sides: an organiser who copied
  // `scmp_009.v0001` out of their maps directory means the vault's v0002 too.
  const wantedFolder = mapKey(withoutVersion(tourneyMap.name.trim()));
  return (
    vault.find((candidate) => mapKey(withoutVersion(candidate.folderName)) === wantedFolder) ?? null
  );
}

/**
 * Every round of the drawn bracket, as the keys the server assigns pools by.
 *
 * `{bracket}:{round}` is the server's own grammar, taken from the matches
 * rather than assembled from a guess about how it spells its bracket names.
 */
export function roundKeys(event: Tourney): { key: string; bracket: string; round: number }[] {
  const wire: Record<string, string> = {
    winners: "wb",
    losers: "lb",
    grandFinal: "gf",
    swiss: "sw",
    freeForAll: "ffa",
  };
  const seen = new Map<string, { key: string; bracket: string; round: number }>();
  for (const entry of event.matches) {
    const key = `${wire[entry.bracket]}:${entry.round}`;
    if (!seen.has(key)) seen.set(key, { key, bracket: entry.bracket, round: entry.round });
  }
  return [...seen.values()];
}

interface MapPoolPanelProps {
  event: Tourney;
  vault: VaultMap[];
  busy: boolean;
  onAssign: (roundKey: string, poolId: string) => void;
}

export function MapPoolPanel({ event, vault, busy, onAssign }: MapPoolPanelProps) {
  const { t } = useTranslation();
  const rounds = roundKeys(event);

  if (event.mapPools.length === 0) {
    return <p className="muted">{t("tournaments.pools.none")}</p>;
  }

  const poolFor = (key: string): MapPool | null => {
    const bound = event.poolAssign.find((assignment) => assignment.round === key);
    if (bound === undefined) return null;
    return event.mapPools.find((pool) => pool.id === bound.poolId) ?? null;
  };

  return (
    <div className="tournament-pools">
      {rounds.length === 0 && <p className="muted">{t("tournaments.pools.noRounds")}</p>}

      {rounds.map(({ key, bracket, round }) => {
        const pool = poolFor(key);
        return (
          <section className="surface tournament-pool-round" key={key}>
            <header className="tournament-pool-header">
              <h5>
                {t(BRACKET_LABELS[bracket as keyof typeof BRACKET_LABELS])}{" "}
                {t("tournaments.bracket.round", { round })}
              </h5>
              <label className="tournament-field">
                <span className="visually-hidden">{t("tournaments.pools.assign")}</span>
                <select
                  value={pool?.id ?? ""}
                  disabled={busy}
                  onChange={(changed) => onAssign(key, changed.target.value)}
                >
                  {/* An empty value clears the binding, which is how a round
                      goes back to having no pool at all. */}
                  <option value="">{t("tournaments.pools.unassigned")}</option>
                  {event.mapPools.map((candidate) => (
                    <option value={candidate.id} key={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
            </header>

            {pool !== null && (
              <ul className="tournament-pool-maps">
                {pool.mapIds.map((mapId) => {
                  const held = event.mapDb.find((candidate) => candidate.id === mapId);
                  if (held === undefined) return null;
                  const vaultMap = matchVaultMap(held, vault);
                  // FAF's own preview is preferred: it is the picture players
                  // already recognise from the maps tab. The tournament
                  // server's copy is the fallback for a map never uploaded.
                  const preview = vaultMap?.thumbnailUrl || held.imageUrl;
                  return (
                    <li className="tournament-pool-map" key={mapId}>
                      {preview ? (
                        <img src={preview} alt="" loading="lazy" aria-hidden />
                      ) : (
                        <span className="tournament-pool-map-blank" aria-hidden />
                      )}
                      <span>{vaultMap?.displayName ?? held.name}</span>
                      {vaultMap === null && (
                        <span className="muted" title={t("tournaments.pools.notInVaultHint")}>
                          {t("tournaments.pools.notInVault")}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

interface ManageLinkProps {
  event: Tourney;
  onOpen: (url: string) => void;
}

/**
 * The way out to the website.
 *
 * Everything this client deliberately does not do lives there: creating the
 * event, its format, its best-of plan, its series. It is done once per event,
 * it is form-heavy, and a second surface for it would be a worse copy of a
 * maintained one.
 */
export function ManageLink({ event, onOpen }: ManageLinkProps) {
  const { t } = useTranslation();
  return (
    <div className="tournament-manage">
      <p className="muted">{t("tournaments.manage.explanation")}</p>
      <Button
        onClick={() =>
          onOpen(`https://tournaments.doodlepros.com/t/${encodeURIComponent(event.id)}`)
        }
      >
        {t("tournaments.manage.open")}
      </Button>
    </div>
  );
}
