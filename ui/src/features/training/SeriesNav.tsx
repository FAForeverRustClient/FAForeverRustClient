// The way through a written series.
//
// A series is read in order, so its parts are laid out the way a book lays out
// chapters: the overview lists them as a grid of chapters, each with what it
// is about, and every part says where it stands and leads on to the next one
// at its end. A row of pills over every page told the reader the parts'
// names and nothing else, and said it again on every one of them.

import { Icon } from "../../design-system/Icon";
import type { TrainingResource } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { chapterTitle, partTitle, type Series } from "./trainingSeries";

/** The parts of a series as chapters, for its overview. */
export function SeriesParts({
  series,
  onSelect,
}: {
  series: Series;
  onSelect: (resource: TrainingResource) => void;
}) {
  const { t } = useTranslation();
  const parts = series.parts.slice(1);
  return (
    <section className="training-series-parts" aria-label={series.title}>
      <h4>{t("training.series.contents")}</h4>
      <ol>
        {parts.map((part, index) => (
          <li key={part.id}>
            <button type="button" onClick={() => onSelect(part)}>
              <span className="training-series-parts-number" aria-hidden>
                {index + 1}
              </span>
              <span className="training-series-parts-text">
                <span className="training-series-parts-eyebrow">
                  {t("training.series.part", { number: index + 1 })}
                </span>
                <strong>{chapterTitle(series, part)}</strong>
              </span>
              <Icon name="arrowRight" size={15} />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Where a part stands in its series, above its text. */
export function SeriesBar({
  series,
  resource,
  onSelect,
}: {
  series: Series;
  resource: TrainingResource;
  onSelect: (resource: TrainingResource) => void;
}) {
  const { t } = useTranslation();
  const at = series.parts.findIndex((part) => part.id === resource.id);
  const previous = at > 1 ? series.parts[at - 1] : null;
  const next = at < series.parts.length - 1 ? series.parts[at + 1] : null;
  return (
    <nav className="training-series-bar" aria-label={series.title}>
      <button
        type="button"
        className="training-series-bar-home"
        onClick={() => onSelect(series.head)}
        title={t("training.series.overview")}
      >
        <Icon name="grid" size={14} />
        <span>{series.title}</span>
      </button>
      <span className="training-series-bar-place">
        {t("training.series.partOf", { number: at, count: series.parts.length - 1 })}
      </span>
      {/* One mark per part, the read ones filled: how far along this is,
          without counting. */}
      <span className="training-series-bar-track" aria-hidden>
        {series.parts.slice(1).map((part, index) => (
          <span key={part.id} className={index + 1 <= at ? "is-done" : undefined} />
        ))}
      </span>
      <span className="training-series-bar-step">
        <button
          type="button"
          disabled={previous === null}
          onClick={() => previous && onSelect(previous)}
          title={previous ? partTitle(series, previous) : undefined}
          aria-label={t("training.series.previous")}
        >
          <Icon name="arrowLeft" size={14} />
        </button>
        <button
          type="button"
          disabled={next === null}
          onClick={() => next && onSelect(next)}
          title={next ? partTitle(series, next) : undefined}
          aria-label={t("training.series.next")}
        >
          <Icon name="arrowRight" size={14} />
        </button>
      </span>
    </nav>
  );
}

/** The parts either side of this one, at the end of its text. */
export function SeriesSteps({
  series,
  resource,
  onSelect,
}: {
  series: Series;
  resource: TrainingResource;
  onSelect: (resource: TrainingResource) => void;
}) {
  const { t } = useTranslation();
  const at = series.parts.findIndex((part) => part.id === resource.id);
  const previous = at > 1 ? series.parts[at - 1] : null;
  const next = at < series.parts.length - 1 ? series.parts[at + 1] : null;
  if (!previous && !next) return null;
  return (
    <nav className="training-series-steps" aria-label={series.title}>
      {previous ? (
        <button type="button" className="is-previous" onClick={() => onSelect(previous)}>
          <span className="training-series-steps-label">
            <Icon name="arrowLeft" size={13} />
            {t("training.series.previous")}
          </span>
          <strong>{partTitle(series, previous)}</strong>
        </button>
      ) : (
        <span />
      )}
      {next && (
        <button type="button" className="is-next" onClick={() => onSelect(next)}>
          <span className="training-series-steps-label">
            {t("training.series.next")}
            <Icon name="arrowRight" size={13} />
          </span>
          <strong>{partTitle(series, next)}</strong>
        </button>
      )}
    </nav>
  );
}
