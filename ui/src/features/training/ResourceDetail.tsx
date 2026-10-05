// One resource in full, and what to read next.
//
// The related list is the reason this pane exists rather than the card linking
// straight out. A collection of documents that cite each other is a training
// graph: "here is the mistake" can point at "here is the lesson that fixes it",
// which is the one thing a client can offer that a wiki page cannot.

import { useEffect, useMemo } from "react";

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { TrainingDocument, TrainingResource } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { openHttpsUrl } from "../../shared/externalLinks";
import { factionLabelFromName } from "../../shared/factions";
import { relatedResources } from "../../shared/rules/trainingRules";
import { useAppStore } from "../../store/store";
import { GuideReader, guideOutline, type GuideOutline } from "./GuideReader";
import { RunAnalysis } from "./RunAnalysis";
import { TrainingArt, TrainingCard } from "./TrainingCard";
import { parseEnvelope } from "./recording";
import {
  actionLabel,
  bandKey,
  isPlayableLesson,
  kindIcon,
  kindLabel,
  levelLabel,
  mapArtUrl,
  playlistId,
  renderedPage,
  topicLabel,
  videoEmbedUrl,
} from "./trainingPresentation";

interface Props {
  resource: TrainingResource;
  resources: TrainingResource[];
  /** The guide's text, once it has been read. */
  guide: TrainingDocument;
  onOpen: (resource: TrainingResource) => void;
  onSelect: (resource: TrainingResource) => void;
  onRead: (resource: TrainingResource) => void;
  onRequestReview: () => void;
  /** Back to whichever section the reader came from. */
  onClose: () => void;
}

export function ResourceDetail({
  resource,
  resources,
  guide,
  onOpen,
  onSelect,
  onRead,
  onRequestReview,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const band = bandKey(resource);
  const related = relatedResources(resources, resource);
  // Whether the address is a video decides this, not what the entry calls
  // itself. Most of the catalogue's videos are build orders, and gating the
  // player on `kind === "video"` meant the one entry filed as a video played
  // here while fourteen build orders on the same channel did not.
  const embed = videoEmbedUrl(resource.url);
  // The rest of the series, from the catalogue rather than from YouTube: two
  // entries carrying the same playlist are two parts of the same thing, which
  // needs no key and no request and stays true as entries are added. What it
  // cannot show is a video of the series nobody has catalogued yet.
  const series = useMemo(() => {
    const list = playlistId(resource.url);
    if (!list) return [];
    return resources.filter((other) => playlistId(other.url) === list);
  }, [resources, resource.url]);
  const vault = useAppStore((store) => store.state.maps.vault);
  // The run map is drawn over the same art the entry's card shows: the
  // catalogue's exact preview where it has one, never a name's best guess.
  const previewUrl = mapArtUrl(vault, resource);
  // Parsed once per document rather than per render: the envelope is a few
  // hundred kilobytes of JSON and this component re-renders on every hover
  // that crosses the panes below it.
  const run = useMemo(
    () => (guide.resourceId === resource.id ? parseEnvelope(guide.recording) : null),
    [guide.resourceId, guide.recording, resource.id],
  );

  // Asked for as soon as the pane opens, not behind a second click. A guide
  // this project hosts is the one thing here that is not somebody else's page,
  // and making the reader ask twice for text the client already has an address
  // for is ceremony.
  useEffect(() => {
    if ((resource.readable || resource.recordingUrl) && guide.resourceId !== resource.id) {
      onRead(resource);
    }
  }, [resource, guide.resourceId, onRead]);

  // The guide's body without the title and byline the header already shows,
  // and the page it was copied from, for the header's link to it.
  const outline = useMemo(
    () =>
      guide.resourceId === resource.id && guide.status.type === "ready"
        ? guideOutline(guide.markdown)
        : null,
    [guide.resourceId, guide.status.type, guide.markdown, resource.id],
  );
  // Somewhere outside the client to read this, when there is one: the page a
  // guide was copied from, or the entry's own address rendered for a browser.
  const outside = outline?.source ?? (resource.url ? renderedPage(resource.url) : "");
  // Opening the entry is the main thing to do with it only when the client
  // cannot show it here: a video plays below and a hosted guide is rendered
  // below, so for those the browser is one more tool on the floor.
  const opensOutside =
    resource.url !== "" && (isPlayableLesson(resource) || (!embed && !resource.readable));
  const openOutside = outside ? () => void openHttpsUrl(outside) : null;

  const facts: Array<[string, string]> = [];
  if (resource.level) facts.push([t("training.detail.level"), t(levelLabel(resource.level))]);
  if (band) facts.push([t("training.detail.rating"), t(band.key, band.values)]);
  if (resource.gameModes.length > 0) {
    facts.push([t("training.detail.modes"), resource.gameModes.join(", ")]);
  }
  if (resource.maps.length > 0) facts.push([t("training.detail.maps"), resource.maps.join(", ")]);
  if (resource.factions.length > 0) {
    facts.push([
      t("training.detail.factions"),
      resource.factions.map(factionLabelFromName).join(", "),
    ]);
  }
  if (resource.durationMinutes !== null) {
    facts.push([
      t("training.detail.duration"),
      t("training.detail.minutes", { count: resource.durationMinutes }),
    ]);
  }
  if (resource.topics.length > 0) {
    facts.push([
      t("training.detail.topics"),
      resource.topics.map((topic) => t(topicLabel(topic))).join(", "),
    ]);
  }

  return (
    // A page rather than an overlay. A build order is something a reader
    // works *through*, sometimes with the game open beside it, and a modal
    // says the opposite: that this is a detour to be dismissed before
    // anything else can happen. It also capped the three-pane run layout at
    // a dialog's width, which is the one place that layout needed room.
    <section className="training-detail-page" aria-label={resource.title}>
      <button type="button" className="training-detail-back" onClick={onClose}>
        <Icon name="arrowLeft" size={15} />
        <span>{t("training.detail.back")}</span>
      </button>

      {/* The replay detail's hero: the entry's picture as a dimmed backdrop,
          the picture itself in front of it, what the entry is, and the way
          in. Under it the facts as one strip, and every other action as a
          flat toolbar along the floor. */}
      <div className="surface-panel training-detail-card">
        <header className="training-detail-hero">
          <div className="training-detail-hero-backdrop" aria-hidden>
            <TrainingArt resource={resource} className="training-detail-hero-image" />
          </div>
          <TrainingArt resource={resource} className="training-detail-art" />
          <div className="training-detail-headtext">
            <span className="training-detail-eyebrow">
              <span className="training-detail-kind">
                <Icon name={kindIcon(resource.kind)} size={13} />
                <span>{t(kindLabel(resource.kind))}</span>
              </span>
              {/* Who vouched for it, in those words: "reviewed", never
                  "official", because accepting an entry is not checking
                  every sentence of it. */}
              {resource.approvedBy && (
                <span className="training-detail-reviewed">
                  <Icon name="check" size={13} />
                  <span>{t("training.reviewedBy", { login: resource.approvedBy })}</span>
                </span>
              )}
            </span>
            <h2>{resource.title}</h2>
            {resource.summary && <p className="training-detail-summary">{resource.summary}</p>}
            {resource.author && (
              <p className="training-detail-byline">
                <Icon name="user" size={14} />
                <span>{resource.author}</span>
              </p>
            )}
          </div>
          {opensOutside && (
            <Button
              variant="primary"
              className="training-detail-hero-action"
              onClick={() => onOpen(resource)}
            >
              <Icon name="external" size={17} /> {t(actionLabel(resource))}
            </Button>
          )}
        </header>

        {facts.length > 0 && (
          <dl className="training-detail-facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd title={value}>{value}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="training-detail-toolbar">
          {/* The other half of the graph: understanding a mistake is one
              thing, having someone look at your own game is another, and this
              is the point in the tab where a player is most likely to want
              it. */}
          <button type="button" className="training-detail-tool" onClick={onRequestReview}>
            <Icon name="replays" size={16} />
            <span>{t("training.detail.askForReview")}</span>
          </button>
          {openOutside && !opensOutside && (
            <button type="button" className="training-detail-tool" onClick={openOutside}>
              <Icon name="external" size={16} />
              <span>
                {t(outline?.source ? "training.detail.original" : "training.detail.openInBrowser")}
              </span>
            </button>
          )}
        </div>
      </div>

      <div className="training-detail">
        {embed && (
          // Played here rather than in a browser, because a player checking a
          // build order mid-game should not be alt-tabbing into a browser and
          // back. The host is the privacy-enhanced one, which is also the only
          // one the client's frame policy allows; an uploader who has disabled
          // embedding gets a frame that says so and offers YouTube, which is
          // the honest outcome and still one click from watching.
          <div className="training-watch">
            <div className="training-detail-video">
              <iframe
                src={embed}
                title={resource.title}
                loading="lazy"
                allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </div>

            {series.length > 1 && (
              <ol className="training-series">
                {series.map((other, index) => (
                  <li key={other.id}>
                    <button
                      type="button"
                      className={other.id === resource.id ? "is-current" : undefined}
                      aria-current={other.id === resource.id ? "true" : undefined}
                      onClick={() => onSelect(other)}
                    >
                      <span className="training-series-number">{index + 1}</span>
                      <span>{other.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {run ? (
          // The written order, the flow and the map, in one layout. The prose
          // is handed in rather than fetched again: it is the same document
          // the pane would otherwise show on its own.
          <RunAnalysis
            env={run}
            previewUrl={previewUrl}
            prose={
              resource.readable ? (
                <GuideBody guide={guide} outline={outline} onOpen={openOutside} />
              ) : null
            }
          />
        ) : (
          (resource.readable || resource.recordingUrl) && (
            <>
              {/* Only an entry with prose has a guide to wait for. A recording
                  on its own used to show "fetching the guide" forever, even
                  beside the line saying the recording had failed. */}
              {resource.readable && (
                <GuideBody guide={guide} outline={outline} onOpen={openOutside} />
              )}
              {resource.recordingUrl && <RunProblem guide={guide} />}
            </>
          )
        )}

        {/* What to read next, as the cards the reader already knows from the
            library rather than a list of titles: the picture is what they
            recognise an entry by. */}
        {related.length > 0 && (
          <section className="training-related">
            <h4>{t("training.detail.related")}</h4>
            <div className="training-related-grid">
              {related.map((other) => (
                <TrainingCard key={other.id} resource={other} onOpen={onOpen} onSelect={onSelect} />
              ))}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

/**
 * The guide, read in the tab.
 *
 * Only ever drawn for an entry the catalogue parser marked readable, which
 * means Markdown in the repository this build trusts. Everything else in the
 * library is somebody else's page behind their own styling and their own
 * login, and the honest thing to do with those is to open a browser.
 *
 * A failure is stated rather than hidden, with a button that opens the guide
 * in a browser right beside it. A readable entry gets no "open" button in the
 * actions above, so the failure text used to point at a button that was not
 * there.
 */
/**
 * Why the recorded run is not on screen, when an entry says it has one.
 *
 * Only ever drawn while the run is missing: a run that parsed is drawn by
 * `RunAnalysis`, and there is nothing to explain. A document that arrived but
 * did not parse is reported as such rather than silently absent, because "this
 * entry claims a recording and shows none" is otherwise a bug with no symptom.
 */
function RunProblem({ guide }: { guide: TrainingDocument }) {
  const { t } = useTranslation();
  if (guide.recordingStatus.type === "failed") {
    return (
      <p className="muted training-run-problem">
        {t("training.run.failed", { reason: guide.recordingStatus.payload.reason })}
      </p>
    );
  }
  if (guide.recordingStatus.type === "ready") {
    return <p className="muted training-run-problem">{t("training.run.unreadable")}</p>;
  }
  return <p className="muted training-run-problem">{t("training.run.loading")}</p>;
}

function GuideBody({
  guide,
  outline,
  onOpen,
}: {
  guide: TrainingDocument;
  /** The guide split for reading, once it has arrived. */
  outline: GuideOutline | null;
  /** Open the guide in a browser instead, or `null` when it has no address. */
  onOpen: (() => void) | null;
}) {
  const { t } = useTranslation();

  if (guide.status.type === "failed") {
    return (
      <div className="training-detail-guide-problem">
        <p className="muted">
          {t("training.detail.guideFailed", { reason: guide.status.payload.reason })}
        </p>
        {onOpen && (
          <Button onClick={onOpen}>
            <Icon name="external" size={15} /> {t("training.detail.openInBrowser")}
          </Button>
        )}
      </div>
    );
  }
  if (guide.status.type !== "ready" || outline === null) {
    return <p className="muted training-detail-guide-problem">{t("training.detail.guideLoading")}</p>;
  }
  // Arrived and empty: nothing to show, and nothing still on its way either.
  if (outline.blocks.length === 0) return null;
  return <GuideReader outline={outline} />;
}
