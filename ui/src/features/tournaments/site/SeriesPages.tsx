// The series index and one series' page: the website's `renderSeriesIndex`
// and `renderSeries`. A series is a label that groups editions; its page lists
// them with their status and winners, keeps the bans that apply to every
// edition, and lets those who may edit it rename, retag or delete it.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import type {
  AccountSearch,
  SeriesColour,
  SeriesDetail,
  SeriesEdition,
  SiteWrite,
  TourneyCategory,
  TourneySeries,
} from "../../../ipc/bindings";
import { t, type MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { RichText } from "../detail/RichText";
import { eventDayCount } from "../orientation";
import { formatDay, STATUS_LABELS } from "../tourneyPresentation";
import { BanList } from "./BanList";

const COLOURS: SeriesColour[] = ["amber", "blue", "green", "red", "purple", "plain"];

/** The edition's status pill: the website's, with its two exceptions. */
function editionPill(edition: SeriesEdition, now: number): { label: MessageKey; tone: string } {
  if (edition.abandoned) return { label: "tournaments.list.abandoned", tone: "abandoned" };
  const opens = edition.signupOpensAt ?? null;
  if (edition.status === "signup" && opens !== null && opens > now) {
    return { label: "tournaments.status.notOpenYet", tone: "presignup" };
  }
  return { label: STATUS_LABELS[edition.status], tone: edition.status };
}

function kindOf(edition: SeriesEdition): string {
  if (edition.competition === "freeForAll") return "FFA";
  const bracket = { single: "SE", double: "DE", swiss: t("tournaments.bracketKind.swiss") }[edition.bracketKind];
  return `${edition.teamSize}v${edition.teamSize} ${bracket}`;
}

function CategoryBadge({ category }: { category: TourneyCategory | null }) {
  const { t } = useTranslation();
  if (category === null) return null;
  return (
    <span className={`tournament-tag is-${category}`}>
      {t(category === "official" ? "tournaments.list.official" : "tournaments.list.community")}
    </span>
  );
}

interface SeriesIndexProps {
  series: TourneySeries[];
  mayCreate: boolean;
  busy: boolean;
  onOpen: (seriesId: string) => void;
  onCreate: (name: string) => void;
}

export function SeriesIndex({ series, mayCreate, busy, onOpen, onCreate }: SeriesIndexProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [officialOnly, setOfficialOnly] = useState(false);
  const shown = series.filter((held) => !officialOnly || held.category === "official");
  const running = shown.filter((held) => held.active > 0);
  const quiet = shown.filter((held) => held.active === 0);
  const row = (held: TourneySeries) => (
    <li key={held.id}>
      <button type="button" className="surface surface-interactive tournament-series-row" onClick={() => onOpen(held.id)}>
        <span className={`tournament-series-name is-${held.colour}`}>{held.name}</span> <CategoryBadge category={held.category} />
        {held.description.trim() !== "" && <span className="muted tournament-series-summary">{held.description}</span>}
        {held.latestName !== "" && (
          <span className="muted">
            {t("tournaments.seriesPage.latest", { name: held.latestName, date: formatDay(held.latestDate, "") })}
          </span>
        )}
        <span className="muted">
          {held.active > 0 && `${t("tournaments.seriesPage.running", { count: held.active })} · `}
          {t("tournaments.series.editions", { count: held.editions })}
        </span>
      </button>
    </li>
  );
  return (
    <div className="tournament-site-page">
      <h2>{t("tournaments.seriesPage.title")}</h2>
      {mayCreate && (
        <section className="surface tournament-site-panel">
          <h3>{t("tournaments.series.create")}</h3>
          <div className="tournament-detail-actions">
            <input
              value={name}
              maxLength={80}
              placeholder={t("tournaments.seriesPage.namePlaceholder")}
              onChange={(changed) => setName(changed.target.value)}
            />
            <Button
              variant="primary"
              disabled={busy || name.trim() === ""}
              onClick={() => {
                onCreate(name.trim());
                setName("");
              }}
            >
              {t("tournaments.seriesPage.create")}
            </Button>
          </div>
          <p className="muted">{t("tournaments.seriesPage.createHint")}</p>
        </section>
      )}
      <section className="surface tournament-site-panel">
        <h3>
          {t("tournaments.seriesPage.heading")}{" "}
          <span className="muted">
            {shown.length === series.length ? `(${series.length})` : `(${shown.length} / ${series.length})`}
          </span>
        </h3>
        <label className="tournament-checkbox">
          <input type="checkbox" checked={officialOnly} onChange={(changed) => setOfficialOnly(changed.target.checked)} />
          <span>{t("tournaments.seriesPage.officialOnly")}</span>
        </label>
        {shown.length === 0 && (
          <p className="muted">{t(officialOnly ? "tournaments.seriesPage.noneOfficial" : "tournaments.seriesPage.none")}</p>
        )}
        {running.length > 0 && (
          <>
            <h4>{t("tournaments.seriesPage.runningNow")}</h4>
            <ul className="tournament-series-list">{running.map(row)}</ul>
          </>
        )}
        {quiet.length > 0 && (
          <>
            <h4>{t("tournaments.seriesPage.quiet")}</h4>
            <ul className="tournament-series-list">{quiet.map(row)}</ul>
          </>
        )}
      </section>
    </div>
  );
}

interface SeriesPageProps {
  series: SeriesDetail;
  assetBase: string;
  busy: boolean;
  accountSearch: AccountSearch;
  onSearchAccounts: (query: string) => void;
  onBack: () => void;
  onOpenEvent: (tournamentId: string) => void;
  onWrite: (write: SiteWrite) => void;
  onSave: (draft: { name: string; description: string; colour: SeriesColour; category: TourneyCategory | null }) => void;
  onDelete: () => void;
}

export function SeriesPage(props: SeriesPageProps) {
  const { t } = useTranslation();
  const { series } = props;
  const now = Math.floor(Date.now() / 1000);
  const [name, setName] = useState(series.name);
  const [description, setDescription] = useState(series.description);
  const [colour, setColour] = useState<SeriesColour>(series.colour);
  const [category, setCategory] = useState<TourneyCategory | null>(series.category);
  // The winners' tally, over the finished editions that were played out.
  const winners = new Map<string, number>();
  for (const edition of series.editions) {
    if (edition.status === "finished" && !edition.abandoned && edition.champion !== "") {
      winners.set(edition.champion, (winners.get(edition.champion) ?? 0) + 1);
    }
  }
  const tally = [...winners.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return (
    <div className="tournament-site-page">
      <button type="button" className="tournament-link-button" onClick={props.onBack}>
        {"←"} {t("tournaments.seriesPage.all")}
      </button>
      <h2 className={`tournament-series-name is-${colour}`}>
        {series.name} <CategoryBadge category={series.category} />
      </h2>
      <RichText source={series.description} assetBase={props.assetBase} />
      <section className="surface tournament-site-panel">
        <h3>
          {t("tournaments.seriesPage.editionsHeading")} <span className="muted">({series.editions.length})</span>
        </h3>
        {series.editions.length === 0 ? (
          <p className="muted">{t("tournaments.seriesPage.noEditions")}</p>
        ) : (
          <ul className="tournament-series-list">
            {series.editions.map((edition) => {
              const pill = editionPill(edition, now);
              const days = eventDayCount(edition.eventDays ?? []);
              return (
                <li key={edition.id}>
                  <button
                    type="button"
                    className="surface surface-interactive tournament-series-row"
                    onClick={() => props.onOpenEvent(edition.id)}
                  >
                    <span>
                      {edition.name}{" "}
                      {!edition.published && (
                        <span
                          className="tournament-badge"
                          title={t(edition.canManage !== false ? "tournaments.list.draftTitle" : "tournaments.list.viewOnlyTitle")}
                        >
                          {t(edition.canManage !== false ? "tournaments.list.draftBadge" : "tournaments.list.viewOnly")}
                        </span>
                      )}
                    </span>
                    <span className="muted">
                      {kindOf(edition)}
                      {edition.eventDate !== null && ` · ${formatDay(edition.eventDate, "")}`}
                      {days > 0 && ` · ${t("tournaments.list.dayCount", { count: days })}`}
                      {edition.champion !== "" && ` · ${t("tournaments.seriesPage.winner", { name: edition.champion })}`}
                    </span>
                    <span className={`tournament-badge is-${pill.tone}`}>{t(pill.label)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {tally.length > 0 && (
        <section className="surface tournament-site-panel">
          <h3>{t("tournaments.seriesPage.winners")}</h3>
          <ol>
            {tally.map(([winner, count]) => (
              <li key={winner}>
                {winner} <span className="muted mono">{count}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {series.canEdit && (
        <BanList
          title={t("tournaments.seriesPage.bansTitle")}
          hint={t("tournaments.seriesPage.bansHint")}
          addLabel={t("tournaments.seriesPage.banAdd")}
          bans={series.bans ?? []}
          search={props.accountSearch}
          busy={props.busy}
          onSearch={props.onSearchAccounts}
          onBan={(account, reason, expires) =>
            props.onWrite({
              type: "seriesBan",
              payload: { seriesId: series.id, fafId: account.fafId, name: account.name, reason, expires },
            })
          }
          onLift={(fafId) => props.onWrite({ type: "seriesUnban", payload: { seriesId: series.id, fafId } })}
        />
      )}
      {series.canEdit && (
        <section className="surface tournament-site-panel">
          <h3>{t("tournaments.seriesPage.manage")}</h3>
          <label className="tournament-field">
            <span>{t("tournaments.series.name")}</span>
            <input value={name} maxLength={80} onChange={(changed) => setName(changed.target.value)} />
          </label>
          <label className="tournament-field">
            <span>{t("tournaments.seriesPage.type")}</span>
            <select
              value={category ?? ""}
              onChange={(changed) =>
                setCategory(changed.target.value === "" ? null : (changed.target.value as TourneyCategory))
              }
            >
              <option value="">{t("tournaments.seriesPage.typeUnset")}</option>
              <option value="official">{t("tournaments.list.official")}</option>
              <option value="community">{t("tournaments.list.community")}</option>
            </select>
          </label>
          <fieldset className="tournament-field">
            <legend>{t("tournaments.seriesPage.nameColour")}</legend>
            <div className="tournament-detail-actions">
              {COLOURS.map((held) => (
                <button
                  type="button"
                  key={held}
                  aria-pressed={colour === held}
                  title={t(`tournaments.series.colour.${held}` as MessageKey)}
                  className={colour === held ? `tournament-colour-swatch is-${held} is-on` : `tournament-colour-swatch is-${held}`}
                  onClick={() => setColour(held)}
                >
                  Aa
                </button>
              ))}
            </div>
          </fieldset>
          <label className="tournament-field">
            <span>{t("tournaments.series.description")}</span>
            <textarea rows={6} maxLength={4000} value={description} onChange={(changed) => setDescription(changed.target.value)} />
          </label>
          <div className="tournament-detail-actions">
            <Button
              variant="primary"
              disabled={props.busy || name.trim() === ""}
              onClick={() => props.onSave({ name: name.trim(), description, colour, category })}
            >
              {t("tournaments.series.save")}
            </Button>
            <Button
              variant="danger"
              disabled={props.busy}
              onClick={() => {
                if (window.confirm(t("tournaments.seriesPage.deleteConfirm", { name: series.name }))) props.onDelete();
              }}
            >
              {t("tournaments.seriesPage.delete")}
            </Button>
          </div>
          <p className="muted">{t("tournaments.seriesPage.deleteNote")}</p>
        </section>
      )}
    </div>
  );
}
