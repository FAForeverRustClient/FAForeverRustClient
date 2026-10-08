// The organiser's controls for an event that already exists.
//
// Each step is offered only from the status the server takes it from: a button
// that answers "Form teams first" is worse than no button, because it reads as
// broken rather than as not-yet.
//
// Two stages. The first is a board of tiles, each naming one group of controls
// and nothing else; the second is that group, on its own, with everything else
// out of the way. Twenty controls in one column is a scroll in which everything
// looks equally important, and the editors are long enough that reaching the
// sixth means passing five.
//
// Three things are not behind a tile, because they are one button each and are
// the ones an organiser wants without hunting: how far the event has got, the
// link to the website, and the two ways of ending it.
//
// The groups, in the order they are wanted:
//
//   Settings    what the event is: the create form again, plus the format
//   Players     the field: add, approve, invite, remove, seed, divide
//   Teams       who plays with whom, while that is still open
//   Maps        the database, the pools, and which round plays which
//   Organisers  co-organisers and casters, and leaving the team
//   Series      this edition's label, and the events that feed it
//   Bans        who may not enter this event at all
//   Chat        the silenced list, and the way back in
//
// Ending early sits beside the lifecycle rather than behind a tile: it is the
// one decision made mid-event, usually in a hurry, by someone watching the
// bracket reach its top four.

import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import type {
  DescImageAnswer,
  AccountSearch,
  EntrantRatings,
  RenameCheck,
  TourneyLoadStatus,
  MapListStatus,
  PlayerSummary,
  Tourney,
  TourneyPhase,
  TourneySeries,
  VaultMap,
} from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { memo, useState } from "react";
import { BracketSetupDialog } from "./BracketSetupDialog";
import { BansPanel } from "./BansPanel";
import { EndEarlyPanel } from "./EndEarlyPanel";
import { EntrantAdmin } from "./EntrantAdmin";
import { ImagesPanel } from "./ImagesPanel";
import { RenamesPanel } from "./RenamesPanel";
import { VetoSettingsPanel } from "./VetoSettingsPanel";
import { FormatPanel } from "./FormatPanel";
import { TournamentForm } from "./TournamentForm";
import { MapDbPanel } from "./MapDbPanel";
import { OrganiserPanel } from "./OrganiserPanel";
import { MapPoolPanel, ManageLink } from "./MapPoolPanel";
import { PoolEditor } from "./PoolEditor";
import { SeriesPanel } from "./SeriesPanel";
import { TeamAdmin } from "./TeamAdmin";
import {
  isLegalFrom,
  mayConfigureFactionVeto,
  mayEditFormat,
  mayEditVeto,
  mayEndEarly,
  mayPublish,
  mayReopenEarly,
  mayRepullRatings,
  mayShuffleTeams,
} from "../../../shared/rules/tourneyRules";
import { FactionVetoPanel } from "./FactionVetoPanel";
import type { MapImport } from "./MapImportDialog";
import { PlayoffsPanel } from "./PlayoffsPanel";
import type {
  ChatActions,
  EntrantActions,
  MapActions,
  OrganiserActions,
  SeriesActions,
  TeamActions,
} from "../tourneyActions";

const PHASE_LABELS: Record<TourneyPhase, MessageKey> = {
  formTeams: "tournaments.manage.formTeams",
  startBracket: "tournaments.manage.startBracket",
  reopenSignups: "tournaments.manage.reopenSignups",
  setCaptains: "tournaments.manage.setCaptains",
  startDraft: "tournaments.manage.startDraft",
};

/** The groups the board is made of. Everything else on the panel is inline. */
type ManageGroup =
  | "settings"
  | "players"
  | "teams"
  | "maps"
  | "organisers"
  | "series"
  | "bans"
  | "chat";

const GROUP_LABELS: Record<ManageGroup, MessageKey> = {
  settings: "tournaments.manage.settings",
  players: "tournaments.manage.entrants",
  teams: "tournaments.manage.teams",
  maps: "tournaments.manage.maps",
  organisers: "tournaments.manage.organisers",
  series: "tournaments.manage.series",
  bans: "tournaments.manage.bans",
  chat: "tournaments.manage.mutes",
};

/**
 * The organiser's notes, as the website keeps them at the foot of its Admin
 * tab: the handful of things nobody finds by looking, said where they are.
 * Rewritten for this client's own places rather than copied, since half of the
 * website's point at its own tabs.
 */
const NOTES: MessageKey[] = [
  "tournaments.notes.maps",
  "tournaments.notes.bestOf",
  "tournaments.notes.news",
  "tournaments.notes.running",
  "tournaments.notes.corrections",
];

const PHASE_HINTS: Record<TourneyPhase, MessageKey> = {
  formTeams: "tournaments.manage.formTeamsHint",
  startBracket: "tournaments.manage.startBracketHint",
  reopenSignups: "tournaments.manage.reopenSignupsHint",
  setCaptains: "tournaments.manage.setCaptainsHint",
  startDraft: "tournaments.manage.startDraftHint",
};

interface ManagePanelProps {
  event: Tourney;
  vault: VaultMap[];
  vaultStatus: MapListStatus;
  /** Where the service lives, for the organisers' uploaded map pictures. */
  assetBase: string;
  /** Every series, for the picker. */
  series: TourneySeries[];
  /** The other events, as candidates for a qualifier link. */
  events: Tourney[];
  /** Forwarded to `EntrantAdmin`, so the organiser's lists show people. */
  profiles: PlayerSummary[];
  /** Forwarded to `EntrantAdmin`'s name pickers. */
  accountSearch: AccountSearch;
  /** The last check of entrant names against FAF. */
  renames: RenameCheck | null;
  renamesStatus: TourneyLoadStatus;
  /** One entrant's every rating. */
  playerRatings: EntrantRatings | null;
  playerRatingsStatus: TourneyLoadStatus;
  /** Importing maps from another event. */
  mapImport: MapImport;
  busy: boolean;
  /** The last picture pasted into the event's text and stored. */
  pastedImage?: DescImageAnswer | null;
  /** A site admin, for whom archiving is deleting and the category is open. */
  siteAdmin?: boolean;
  onOpenUrl: (url: string) => void;
  /** The lifecycle, the settings form (inline here, so no dialog) and the staff. */
  organiser: OrganiserActions;
  /** The field: adding, approving, inviting, seeding, dividing. */
  entrants: EntrantActions;
  /** Handing a team's armband to somebody else. */
  teams: Pick<TeamActions, "setCaptain">;
  /** The map database, the pools, the rounds' pools and the faction veto. */
  maps: MapActions;
  seriesActions: SeriesActions;
  /** Unmuting, from the silenced list. */
  chat: Pick<ChatActions, "mute">;
}

/**
 * Memoised: the organiser's longest section, and none of the chat polls or
 * pinned-room posts that redraw the pane above it reach anything in here.
 */
export const ManagePanel = memo(function ManagePanel({
  event,
  vault,
  profiles,
  accountSearch,
  busy,
  onOpenUrl,
  organiser,
  entrants,
  teams,
  maps,
  seriesActions,
  chat,
  ...rest
}: ManagePanelProps) {  const { t } = useTranslation();
  // Reopening throws the teams away, so it is offered apart from the two steps
  // that move forward rather than beside them.
  // A draft event forms its teams by drafting, so `formTeams` is not offered
  // there and the draft section carries `startDraft` instead.
  const forward: TourneyPhase[] =
    event.formation === "draft" ? ["startBracket"] : ["formTeams", "startBracket"];
  const canReopen = isLegalFrom("reopenSignups", event.status) && event.teamCount > 0;
  /** Whether the bracket-setup dialog is open. */
  const [drawing, setDrawing] = useState(false);
  /** Which group is open, or null while the board is showing. */
  const [open, setOpen] = useState<ManageGroup | null>(null);

  /**
   * A tile on the board.
   *
   * The count is what makes the board worth looking at rather than a menu: an
   * organiser opens Players because there are four signups waiting, and the tile
   * can say so without being opened.
   */
  const tile = (group: ManageGroup, note?: string) => (
    <button
      type="button"
      className="tournament-tile tournament-tile-button"
      key={group}
      onClick={() => setOpen(group)}
    >
      <span className="tournament-tile-title">{t(GROUP_LABELS[group])}</span>
      {note !== undefined && <span className="muted">{note}</span>}
      <Icon name="chevronRight" size={16} />
    </button>
  );

  return (
    <div className="tournament-manage-panel">
      {drawing && (
        <BracketSetupDialog
          event={event}
          busy={busy}
          onClose={() => setDrawing(false)}
          onStart={(config) => {
            organiser.advance("startBracket", config);
            setDrawing(false);
          }}
        />
      )}
      {open === null ? (
        <>
          {/* Stage one: what there is to work on, and nothing else. Each tile is
              a name and, where the service knows one, a number worth acting on. */}
          <div className="tournament-tiles">
            {tile("settings")}
            {tile(
              "players",
              t("tournaments.manage.playersNote", { count: event.players.length }),
            )}
            {mayShuffleTeams(event) && event.teams.length > 0 && tile("teams")}
            {tile("maps", t("tournaments.manage.mapsNote", { count: event.mapDb.length }))}
            {tile("organisers")}
            {tile("series")}
            {tile(
              "bans",
              event.bans.length > 0
                ? t("tournaments.manage.bansNote", { count: event.bans.length })
                : undefined,
            )}
            {event.chatMutes.length > 0 &&
              tile("chat", t("tournaments.manage.chatNote", { count: event.chatMutes.length }))}
          </div>

          {/* Inline, not behind a tile: one button each, and the ones an organiser
              reaches for without looking. */}
          <div className="tournament-tiles">
            {/* One tile for the event's own state. Publishing was a section of its
                own and is really the first step of the same sequence: an unpublished
                event cannot be entered, so nothing below it matters yet. It keeps its
                warning colour, because it is the step people forget. */}
            <section
              className={
                mayPublish(event) ? "tournament-tile is-unpublished" : "tournament-tile"
              }
            >
              <h5>{t("tournaments.manage.lifecycle")}</h5>
              {mayPublish(event) && (
                <>
                  <p className="muted">{t("tournaments.manage.unpublishedHint")}</p>
                  <div className="tournament-detail-actions">
                    <Button variant="primary" disabled={busy} onClick={organiser.publish}>
                      <Icon name="eye" size={16} /> {t("tournaments.manage.publish")}
                    </Button>
                  </div>
                </>
              )}
              <div className="tournament-detail-actions">
                {forward
                  .filter((phase) => isLegalFrom(phase, event.status))
                  .map((phase) => (
                    <Button
                      key={phase}
                      variant="primary"
                      disabled={busy}
                      title={t(PHASE_HINTS[phase])}
                      // Drawing the bracket is the one step that asks a question
                      // first: the best-of per round, which only makes sense once the
                      // team count is known and is therefore never asked earlier.
                      onClick={() =>
                        phase === "startBracket" ? setDrawing(true) : organiser.advance(phase)
                      }
                    >
                      {t(PHASE_LABELS[phase])}
                    </Button>
                  ))}
                {canReopen && (
                  <Button
                    disabled={busy}
                    title={t(PHASE_HINTS.reopenSignups)}
                    onClick={() => organiser.advance("reopenSignups")}
                  >
                    {t(PHASE_LABELS.reopenSignups)}
                  </Button>
                )}
                {event.status === "running" && (
                  <span className="muted">{t("tournaments.manage.running")}</span>
                )}
                {event.status === "finished" && (
                  <span className="muted">{t("tournaments.manage.finished")}</span>
                )}
              </div>
            </section>

            <section className="tournament-tile">
              <h5>{t("tournaments.manage.website")}</h5>
              <ManageLink event={event} onOpen={onOpenUrl} />
            </section>

            {/* A running Swiss stage's playoffs: who picks, the clock, how
                equal records are ordered, and undoing or redoing them. */}
            {event.status === "running" && event.playoffs !== null && (
              <section className="tournament-tile is-wide">
                <h5>{t("tournaments.playoffs.title")}</h5>
                <PlayoffsPanel event={event} busy={busy} onAdmin={organiser.admin} />
              </section>
            )}

            {(mayEndEarly(event) || mayReopenEarly(event)) && (
              <section className="tournament-tile is-wide">
                <h5>
                  {t(mayReopenEarly(event) ? "tournaments.endEarly.endedTitle" : "tournaments.endEarly.title")}
                </h5>
                <EndEarlyPanel event={event} busy={busy} onAdmin={organiser.admin} />
              </section>
            )}

            {/* Last, and together: both of these end the event, and one tile is how
                the difference between them gets stated. Abandoning leaves it visible
                and says it was called off, and is reversible here; archiving hides it
                from everyone and only a site admin can undo that. */}
            <section className="tournament-tile is-danger">
              <h5>{t("tournaments.manage.ending")}</h5>
              <div className="tournament-step">
                <h6>{t("tournaments.manage.abandon")}</h6>
                <p className="tournament-step-hint muted">{t("tournaments.manage.abandonHint")}</p>
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (event.abandoned) {
                      organiser.abandon(false);
                      return;
                    }
                    if (window.confirm(t("tournaments.manage.abandonConfirm", { name: event.name }))) {
                      organiser.abandon(true);
                    }
                  }}
                >
                  {event.abandoned
                    ? t("tournaments.manage.unabandon")
                    : t("tournaments.manage.abandon")}
                </Button>
              </div>
              {/* The website's category switch: organisers choose once, at
                  creation, and only a site admin changes it afterwards. */}
              {rest.siteAdmin === true && !event.imported && (
                <div className="tournament-step">
                  <h6>{t("tournaments.manage.categoryTitle")}</h6>
                  <p className="tournament-step-hint muted">{t("tournaments.manage.categoryHint")}</p>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      const category = event.category === "official" ? "community" : "official";
                      if (window.confirm(t(category === "official" ? "tournaments.manage.toOfficialConfirm" : "tournaments.manage.toCommunityConfirm"))) {
                        organiser.admin({ type: "setCategory", payload: { category } });
                      }
                    }}
                  >
                    {t(event.category === "official" ? "tournaments.manage.toCommunity" : "tournaments.manage.toOfficial")}
                  </Button>
                </div>
              )}
              {/* The service's `delete` archives for an organiser and deletes
                  outright for a site admin. The website's button says
                  "archive" either way; here a site admin is told the truth. */}
              <div className="tournament-step">
                <h6>{t(rest.siteAdmin === true ? "tournaments.manage.deleteForever" : "tournaments.manage.archive")}</h6>
                <p className="tournament-step-hint muted">
                  {t(rest.siteAdmin === true ? "tournaments.manage.deleteForeverHint" : "tournaments.manage.archiveHint")}
                </p>
                <Button
                  variant={rest.siteAdmin === true ? "danger" : undefined}
                  disabled={busy}
                  onClick={() => {
                    const confirm =
                      rest.siteAdmin === true
                        ? t("tournaments.manage.deleteForeverConfirm", { name: event.name })
                        : t("tournaments.manage.archiveConfirm", { name: event.name });
                    if (window.confirm(confirm)) organiser.archive();
                  }}
                >
                  {t(rest.siteAdmin === true ? "tournaments.manage.deleteForever" : "tournaments.manage.archive")}
                </Button>
              </div>
            </section>
          </div>

          <details className="tournament-notes">
            <summary>{t("tournaments.notes.title")}</summary>
            <ul className="muted">
              {NOTES.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <>
          {/* Stage two: one group, with a way back. */}
          <button type="button" className="tournament-back" onClick={() => setOpen(null)}>
            <Icon name="close" size={14} /> {t("tournaments.manage.back")}
          </button>

          {/* What the event *is*, and the form is the section rather than a
              button that opens the same form in a dialog on top of it. The
              format sits under it: both answer "what am I running", and the
              format is the half the service stops accepting at the draw. */}
          {open === "settings" && (
            <section className="tournament-tile is-wide">
              <h5>{t("tournaments.manage.settings")}</h5>
              <TournamentForm
                event={event}
                series={rest.series}
                busy={busy}
                inline
                onUploadImage={organiser.uploadImage}
                pastedImage={rest.pastedImage}
                onSubmit={organiser.editInfo}
                onClose={() => setOpen(null)}
              />
              {mayEditFormat(event) && (
                <div className="tournament-step">
                  <h6>{t("tournaments.manage.format")}</h6>
                  <FormatPanel event={event} busy={busy} onSave={organiser.editFormat} />
                </div>
              )}
              {/* Beside the form's rating fields, because it is what makes a
                  change to them count for the people already entered: the
                  service never rewrites a stored rating on its own. */}
              {mayRepullRatings(event) && (
                <div className="tournament-step">
                  <h6>{t("tournaments.ratings.repullTitle")}</h6>
                  <p className="tournament-step-hint muted">
                    {t("tournaments.ratings.repullHint", { count: event.players.length })}
                  </p>
                  <Button
                    disabled={busy || event.players.length === 0}
                    onClick={() => organiser.admin({ type: "repullRatings" })}
                  >
                    {t("tournaments.ratings.repull", { count: event.players.length })}
                  </Button>
                </div>
              )}
              <div className="tournament-step">
                <h6>{t("tournaments.images.title")}</h6>
                <ImagesPanel
                  event={event}
                  assetBase={rest.assetBase}
                  busy={busy}
                  onAdmin={organiser.admin}
                />
              </div>
            </section>
          )}

          {open === "players" && (
          <section className="tournament-tile is-wide">
            <h5>{t("tournaments.manage.entrants")}</h5>
            <EntrantAdmin
              event={event}
              profiles={profiles}
              accountSearch={accountSearch}
              busy={busy}
              entrants={entrants}
              playerRatings={rest.playerRatings}
              playerRatingsStatus={rest.playerRatingsStatus}
              onReplace={(playerId, replacement) =>
                organiser.admin({ type: "replacePlayer", payload: { playerId, with: replacement } })
              }
            />
            <div className="tournament-step">
              <h6>{t("tournaments.renames.title")}</h6>
              <RenamesPanel
                check={rest.renames}
                status={rest.renamesStatus}
                busy={busy}
                onCheck={entrants.checkRenames}
                onAdmin={organiser.admin}
              />
            </div>
          </section>
          )}

          {/* Only while the teams still decide anything: once the bracket is drawn
              the service refuses every one of these, because the draw was made from
              the teams. */}
          {open === "teams" && mayShuffleTeams(event) && event.teams.length > 0 && (
            <section className="tournament-tile is-wide">
              <h5>{t("tournaments.manage.teams")}</h5>
              <TeamAdmin
                event={event}
                profiles={profiles}
                busy={busy}
                onSetCaptain={teams.setCaptain}
                onMovePlayer={entrants.movePlayer}
                onEditPlayer={entrants.editPlayer}
                onSetDivision={entrants.setDivision}
              />
            </section>
          )}

          {/* Three steps in a fixed order, and the order is shown rather than
              explained: a pool cannot be built out of maps the event does not
              have, and no round can be bound to a pool that does not exist. So
              the second step is inert until the database holds something and the
              third until a pool exists, the steps are numbered down the left,
              and the one that can be worked on is the one that is lit. Nobody
              has to read a sentence to find out what comes first. */}
          {open === "maps" && (
            <section className="tournament-tile is-wide">
              <h5>{t("tournaments.manage.maps")}</h5>
              <ol className="tournament-flow">
                <li className="tournament-flow-step is-open">
                  <h6>{t("tournaments.manage.mapsStepDb")}</h6>
                  <MapDbPanel
                    event={event}
                    vault={vault}
                    vaultStatus={rest.vaultStatus}
                    assetBase={rest.assetBase}
                    busy={busy}
                    onSave={maps.saveMap}
                    onPublish={maps.publishMap}
                    onDelete={maps.deleteMap}
                    onAdmin={organiser.admin}
                    imports={rest.mapImport}
                  />
                </li>
                <li
                  className={
                    event.mapDb.length === 0
                      ? "tournament-flow-step is-locked"
                      : "tournament-flow-step is-open"
                  }
                  aria-disabled={event.mapDb.length === 0}
                >
                  <h6>{t("tournaments.manage.mapsStepPool")}</h6>
                  <PoolEditor
                    event={event}
                    busy={busy}
                    onSave={maps.savePool}
                    onPublish={maps.publishPool}
                    onDelete={maps.deletePool}
                    onAdmin={organiser.admin}
                  />
                </li>
                <li
                  className={
                    event.mapPools.length === 0
                      ? "tournament-flow-step is-locked"
                      : "tournament-flow-step is-open"
                  }
                  aria-disabled={event.mapPools.length === 0}
                >
                  <h6>{t("tournaments.manage.mapsStepAssign")}</h6>
                  <MapPoolPanel
                    event={event}
                    vault={vault}
                    assetBase={rest.assetBase}
                    busy={busy}
                    onAssign={maps.assignPool}
                    onSavePool={maps.savePool}
                  />
                </li>
              </ol>
              {mayEditVeto(event) && (
                <>
                  <h6>{t("tournaments.form.vetoLegend")}</h6>
                  <VetoSettingsPanel
                    key={JSON.stringify(event.veto)}
                    event={event}
                    busy={busy}
                    onAdmin={organiser.admin}
                  />
                </>
              )}
              {/* Beside the maps because the website keeps the two veto
                  settings together: both decide what a match's run holds. */}
              {mayConfigureFactionVeto(event) && (
                <>
                  <h6>{t("tournaments.faction.adminTitle")}</h6>
                  <FactionVetoPanel event={event} busy={busy} onSave={maps.setFactionVeto} />
                </>
              )}
            </section>
          )}

          {open === "organisers" && (
          <section className="tournament-tile">
            <h5>{t("tournaments.manage.organisers")}</h5>
            <OrganiserPanel
              event={event}
              accountSearch={accountSearch}
              busy={busy}
              onSearchAccounts={entrants.searchAccounts}
              onAdd={organiser.addOrganiser}
              onSetVisibility={organiser.setOrganiserVisibility}
              onSetCaster={organiser.setCaster}
              onRemove={(fafId) => organiser.admin({ type: "removeOrganiser", payload: { fafId } })}
            />
          </section>
          )}

          {open === "series" && (
          <section className="tournament-tile">
            <SeriesPanel
              event={event}
              series={rest.series}
              events={rest.events}
              busy={busy}
              actions={seriesActions}
              onSeedFrom={(linkId, seedFrom) =>
                organiser.admin({ type: "qualifierSeed", payload: { linkId, seedFrom } })
              }
            />
          </section>
          )}

          {open === "bans" && (
            <section className="tournament-tile is-wide">
              <h5>{t("tournaments.manage.bans")}</h5>
              <BansPanel
                event={event}
                accountSearch={accountSearch}
                busy={busy}
                onSearchAccounts={entrants.searchAccounts}
                onAdmin={organiser.admin}
              />
            </section>
          )}

          {/* Who is silenced, and the way back. Muting happens on the post that
              prompted it; unmuting cannot, because a silenced account has nothing
              on screen to act on. */}
          {open === "chat" && event.chatMutes.length > 0 && (
            <section className="tournament-tile">
              <h5>{t("tournaments.manage.mutes")}</h5>
              <ul className="tournament-mute-list">
                {event.chatMutes.map((mute) => (
                  <li key={mute.fafId} className="tournament-mute">
                    <span>{mute.name}</span>
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => chat.mute(mute.fafId, mute.name, false)}
                    >
                      {t("tournaments.manage.unmute")}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

        </>
      )}
    </div>
  );
});
