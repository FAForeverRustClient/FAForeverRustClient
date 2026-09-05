// One resource in full, and what to read next.
//
// The related list is the reason this pane exists rather than the card linking
// straight out. A collection of documents that cite each other is a training
// graph: "here is the mistake" can point at "here is the lesson that fixes it",
// which is the one thing a client can offer that a wiki page cannot.

import { useEffect } from "react";

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import type { TrainingDocument, TrainingResource } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { relatedResources } from "../../shared/trainingRules";
import { Markdown } from "./markdown";
import {
  actionLabel,
  bandKey,
  isPlayableLesson,
  kindIcon,
  kindLabel,
  levelLabel,
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
  const embed = resource.kind === "video" ? videoEmbedUrl(resource.url) : "";

  // Asked for as soon as the pane opens, not behind a second click. A guide
  // this project hosts is the one thing here that is not somebody else's page,
  // and making the reader ask twice for text the client already has an address
  // for is ceremony.
  useEffect(() => {
    if (resource.readable && guide.resourceId !== resource.id) {
      onRead(resource);
    }
  }, [resource, guide.resourceId, onRead]);

  return (
    <Modal onClose={onClose} ariaLabel={resource.title} className="training-detail-modal">
      <div className="training-detail">
        <header>
          <span className="training-card-kind">
            <Icon name={kindIcon(resource.kind)} size={14} />
            <span>{t(kindLabel(resource.kind))}</span>
          </span>
          <h3>{resource.title}</h3>
          {resource.summary && <p className="training-detail-summary">{resource.summary}</p>}
        </header>

        {embed && (
          // Played here rather than in a browser, because a player checking a
          // build order mid-game should not be alt-tabbing into a browser and
          // back. The host is the privacy-enhanced one, which is also the only
          // one the client's frame policy allows; an uploader who has disabled
          // embedding gets a frame that says so and offers YouTube, which is
          // the honest outcome and still one click from watching.
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
        )}

        <dl className="training-detail-meta">
          {resource.level && (
            <div>
              <dt>{t("training.detail.level")}</dt>
              <dd>{t(levelLabel(resource.level))}</dd>
            </div>
          )}
          {band && (
            <div>
              <dt>{t("training.detail.rating")}</dt>
              <dd>{t(band.key, band.values)}</dd>
            </div>
          )}
          {resource.gameModes.length > 0 && (
            <div>
              <dt>{t("training.detail.modes")}</dt>
              <dd>{resource.gameModes.join(", ")}</dd>
            </div>
          )}
          {resource.maps.length > 0 && (
            <div>
              <dt>{t("training.detail.maps")}</dt>
              <dd>{resource.maps.join(", ")}</dd>
            </div>
          )}
          {resource.factions.length > 0 && (
            <div>
              <dt>{t("training.detail.factions")}</dt>
              <dd>{resource.factions.join(", ")}</dd>
            </div>
          )}
          {resource.durationMinutes !== null && (
            <div>
              <dt>{t("training.detail.duration")}</dt>
              <dd>{t("training.detail.minutes", { count: resource.durationMinutes })}</dd>
            </div>
          )}
          {resource.author && (
            <div>
              <dt>{t("training.detail.author")}</dt>
              <dd>{resource.author}</dd>
            </div>
          )}
        </dl>

        {resource.topics.length > 0 && (
          <div className="training-card-tags">
            {resource.topics.map((topic) => (
              <span className="training-tag" key={topic}>
                {t(topicLabel(topic))}
              </span>
            ))}
          </div>
        )}

        <div className="training-detail-actions">
          <Button variant="primary" onClick={() => onOpen(resource)}>
            <Icon name={isPlayableLesson(resource) ? "play" : "external"} size={16} />{" "}
            {t(actionLabel(resource))}
          </Button>
          {/* The other half of the graph: understanding a mistake is one thing,
              having someone look at your own game is another, and this is the
              point in the tab where a player is most likely to want it. */}
          <Button onClick={onRequestReview}>
            <Icon name="replays" size={16} /> {t("training.detail.askForReview")}
          </Button>
        </div>

        {resource.readable && <GuideBody guide={guide} />}

        {related.length > 0 && (
          <section className="training-related">
            <h4>{t("training.detail.related")}</h4>
            <ul>
              {related.map((other) => (
                <li key={other.id}>
                  <button type="button" onClick={() => onSelect(other)}>
                    <Icon name={kindIcon(other.kind)} size={13} />
                    <span>{other.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}

/**
 * The guide, read in the tab.
 *
 * Only ever drawn for an entry the catalogue parser marked readable, which
 * means Markdown in the repository this build trusts. Everything else in the
 * library is somebody else's page behind their own styling and their own
 * login, and the honest thing to do with those is the button above.
 *
 * A failure is stated rather than hidden: the reader still has that button,
 * and "this could not be fetched" is a different situation from "this entry is
 * a link", which they should be able to tell apart.
 */
function GuideBody({ guide }: { guide: TrainingDocument }) {
  const { t } = useTranslation();

  if (guide.status.type === "failed") {
    return (
      <p className="muted training-detail-guide-problem">
        {t("training.detail.guideFailed", { reason: guide.status.payload.reason })}
      </p>
    );
  }
  if (guide.status.type !== "ready" || !guide.markdown) {
    return <p className="muted training-detail-guide-problem">{t("training.detail.guideLoading")}</p>;
  }
  return <Markdown source={guide.markdown} className="training-detail-guide" />;
}
