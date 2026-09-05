// One resource in full, and what to read next.
//
// The related list is the reason this pane exists rather than the card linking
// straight out. A collection of documents that cite each other is a training
// graph: "here is the mistake" can point at "here is the lesson that fixes it",
// which is the one thing a client can offer that a wiki page cannot.

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import type { TrainingResource } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { relatedResources } from "../../shared/trainingRules";
import {
  actionLabel,
  bandKey,
  isPlayableLesson,
  kindIcon,
  kindLabel,
  levelLabel,
  topicLabel,
} from "./trainingPresentation";

interface Props {
  resource: TrainingResource;
  resources: TrainingResource[];
  onOpen: (resource: TrainingResource) => void;
  onSelect: (resource: TrainingResource) => void;
  onRequestReview: () => void;
  onClose: () => void;
}

export function ResourceDetail({
  resource,
  resources,
  onOpen,
  onSelect,
  onRequestReview,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const band = bandKey(resource);
  const related = relatedResources(resources, resource);

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
