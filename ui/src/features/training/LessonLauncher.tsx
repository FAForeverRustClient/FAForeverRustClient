// Starting a catalogue lesson, and what came of the last runs.
//
// One component for the two places a lesson can be started from: its row in
// the Lessons section and its own page. Both read the same state, so the
// button, the progress and the best run cannot disagree between them.
//
// Nothing here decides anything. Which lesson is busy, what counts as a best
// run and when a result is read are all the backend's: this file draws
// `lessonLaunch` and `lessonRecords` and sends two commands.

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { AppCommand, LessonRecord, TrainingResource } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { useAppStore } from "../../store/store";
import { TrainingArt } from "./TrainingCard";
import {
  isCatalogueLesson,
  lessonBusy,
  lessonLaunchFor,
  lessonTime,
} from "./trainingPresentation";

const launch = (resourceId: string) =>
  ipc.send({
    kind: "Training",
    command: { type: "launchLesson", payload: { resourceId } },
  } satisfies AppCommand);

const cancel = () =>
  ipc.send({ kind: "Training", command: { type: "cancelLessonLaunch" } } satisfies AppCommand);

/** The start button, what the launch is doing, and the kept results. */
export function LessonLauncher({
  resource,
  className,
}: {
  resource: TrainingResource;
  className?: string;
}) {
  const { t } = useTranslation();
  const launchState = useAppStore((store) => store.state.training.lessonLaunch);
  const record = useAppStore(
    (store) => store.state.training.lessonRecords[resource.id] as LessonRecord | undefined,
  );
  const mine = lessonLaunchFor(launchState, resource.id);
  // Any lesson in flight holds every button: the game slot runs one at a time.
  const busy = lessonBusy(launchState);

  return (
    <div className={["training-lesson-launcher", className].filter(Boolean).join(" ")}>
      {mine?.type === "preparing" ? (
        <div className="training-lesson-actions">
          <span className="training-lesson-status" role="status">
            <Icon name="hourglass" size={15} />
            <span>{t("training.lesson.preparing")}</span>
            {mine.payload.detail && <small>{mine.payload.detail}</small>}
          </span>
          <Button onClick={cancel}>{t("common.cancel")}</Button>
        </div>
      ) : (
        <div className="training-lesson-actions">
          <Button variant="primary" disabled={busy} onClick={() => launch(resource.id)}>
            <Icon name="play" size={16} />
            {t(record ? "training.lesson.again" : "training.lesson.start")}
          </Button>
        </div>
      )}

      {mine?.type === "playing" && (
        <p className="training-lesson-note" role="status">
          {t("training.lesson.playing")}
        </p>
      )}
      {mine?.type === "failed" && (
        <p className="training-lesson-note is-error" role="alert">
          <Icon name="alert" size={14} />
          <span>{t("training.lesson.failed", { reason: mine.payload.reason })}</span>
        </p>
      )}
      {mine?.type === "finished" && mine.payload.score === null && (
        <p className="training-lesson-note">{t("training.lesson.quit")}</p>
      )}

      <LessonRecordLines record={record} />
    </div>
  );
}

/** The best run, the last one when it differs, and how many there were. */
function LessonRecordLines({ record }: { record: LessonRecord | undefined }) {
  const { t } = useTranslation();
  if (!record) {
    return <p className="training-lesson-unplayed">{t("training.lesson.notPlayed")}</p>;
  }
  const { best, last } = record;
  const sameRun =
    best.stars === last.stars && best.seconds === last.seconds && best.maxStars === last.maxStars;
  return (
    <div className="training-lesson-record">
      <p>
        <Icon name="star" size={14} />
        <span>
          {t("training.lesson.best", {
            stars: best.stars,
            max: best.maxStars,
            time: lessonTime(best.seconds),
          })}
        </span>
      </p>
      {!sameRun && (
        <p className="is-secondary">
          {t("training.lesson.last", {
            stars: last.stars,
            max: last.maxStars,
            time: lessonTime(last.seconds),
          })}
        </p>
      )}
      <p className="is-secondary">{t("training.lesson.runs", { count: record.runs })}</p>
    </div>
  );
}

/**
 * The Lessons section: every catalogue lesson as a row with its own launcher.
 *
 * Rows rather than the library's cards, because a lesson is something played
 * again and again: the start button and the best run belong on the surface,
 * not one click down on the detail page.
 */
export function LessonsPanel({
  resources,
  onSelect,
}: {
  resources: TrainingResource[];
  onSelect: (resource: TrainingResource) => void;
}) {
  const { t } = useTranslation();
  const lessons = resources.filter(isCatalogueLesson);
  return (
    <section className="training-lessons">
      <p className="training-lessons-lead">{t("training.lessons.lead")}</p>
      <ul className="training-lessons-list">
        {lessons.map((lesson) => (
          <li key={lesson.id} className="surface-panel training-lesson-row">
            <TrainingArt resource={lesson} className="training-lesson-art" />
            <div className="training-lesson-copy">
              <h3>{lesson.title}</h3>
              {lesson.summary && <p>{lesson.summary}</p>}
              <button
                type="button"
                className="training-detail-tool"
                onClick={() => onSelect(lesson)}
              >
                <Icon name="info" size={15} />
                <span>{t("training.lesson.details")}</span>
              </button>
            </div>
            <LessonLauncher resource={lesson} />
          </li>
        ))}
      </ul>
    </section>
  );
}
