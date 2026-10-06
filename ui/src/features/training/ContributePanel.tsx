// Submitting training material: a workspace, not a dialog.
//
// It was a modal, and writing a guide in a modal is the wrong shape: the thing
// being written is long, it is Markdown, and the author wants to see what it
// will look like while they write it. So the form is a page with the editor on
// the left and a live preview on the right.
//
// The tag block is the point of the left column. A trainer's bottleneck is not
// writing guides, it is that everything arriving from the community has to be
// categorised by hand before anyone can find it: which rating, which mode,
// which map, which topic. Asking the author, once, while they still have the
// answers in mind, is the whole difference between a submission a maintainer
// accepts in one press and one that needs a conversation first.
//
// What it never asks for is an id: that is derived from the title, because an
// id is a file name and a key other entries point at, which is not something to
// ask an author to invent.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { MultiSelect } from "../../design-system/MultiSelect";
import { Select, type SelectOption } from "../../design-system/Select";
import type {
  ContributionDraft,
  ForumPost,
  GuidesState,
  TrainingKind,
  TrainingLevel,
  TrainingResource,
  TrainingTopic,
} from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { FACTION_NAMES, factionLabel } from "../../shared/factions";
import { contributionProblem } from "../../shared/rules/trainingRules";
import {
  normaliseRatings,
  parseRating,
  ratingProblem,
  sameDraft,
  splitMaps,
  type RatingProblem,
} from "./contributionDraft";
import {
  ACCEPTED_TYPES,
  attach,
  clearAttachments,
  detach,
  imageMarkdown,
  localImages,
  useAttachments,
  withoutImage,
  type AttachProblem,
} from "./contributionImages";
import { Markdown } from "./markdown";
import { MarkdownField } from "./MarkdownField";
import { PostPreview } from "./PostPreview";
import { TrainingCard } from "./TrainingCard";
import { useAppStore } from "../../store/store";
import {
  KINDS,
  LEVELS,
  contributionProblemLabel,
  kindLabel,
  levelLabel,
  topicLabel,
  TOPICS,
} from "./trainingPresentation";

const NO_LEVEL = "";

const RATING_PROBLEM_LABELS: Record<RatingProblem, MessageKey> = {
  ratingMinInvalid: "training.contribute.ratingProblem.minInvalid",
  ratingMaxInvalid: "training.contribute.ratingProblem.maxInvalid",
  ratingOrder: "training.contribute.ratingProblem.order",
};

const ATTACH_PROBLEM_LABELS: Record<AttachProblem, MessageKey> = {
  type: "training.contribute.imageProblem.type",
  size: "training.contribute.imageProblem.size",
  count: "training.contribute.imageProblem.count",
  total: "training.contribute.imageProblem.total",
};

/** A file size the way a person reads one. */
function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The catalogue stores factions as lowercase slugs of the game's own words;
 * the labels are the reader's names for them (see `shared/factions.ts`).
 * A function, not a constant, so the labels follow a language switch.
 */
function catalogueFactions() {
  return [1, 2, 3, 4].map((id) => ({
    value: FACTION_NAMES[id].toLowerCase(),
    label: factionLabel(id),
  }));
}

/**
 * How long typing has to pause before the draft is handed to the state.
 *
 * Long enough that a word in progress is one command rather than one per key,
 * short enough that switching to the library straight after a sentence loses
 * nothing even before the unmount sends the rest.
 */
const KEEP_AFTER_MS = 700;

interface Props {
  /** The draft in the state: an empty one, or what was kept last time. */
  prefilled: ContributionDraft;
  post: ForumPost | null;
  guides: GuidesState;
  /** The modes to tag with: the queues, then whatever the catalogue carries. */
  modes: string[];
  onCompose: (draft: ContributionDraft) => void;
  /** Hand the draft to the state without composing anything. */
  onKeep: (draft: ContributionDraft) => void;
  /** Send it straight to the repository, or `null` when the client cannot. */
  onSubmit: ((draft: ContributionDraft) => void) | null;
  onReset: () => void;
}

/** The preview card is a picture of a card: pressing it goes nowhere. */
const ignore = () => {};

export function ContributePanel({
  prefilled,
  post,
  guides,
  modes,
  onCompose,
  onKeep,
  onSubmit,
  onReset,
}: Props) {
  const { t } = useTranslation();
  // The author, as the card will name them once the entry is accepted.
  const author = useAppStore((store) => store.state.auth.player?.name ?? "");
  // Owned locally while it is being written: a controlled textarea driven
  // through the backend would round-trip every keystroke.
  const [draft, setDraft] = useState(prefilled);
  // The maps field is edited as text and read as a list. Rebuilding the text
  // from the list on every keystroke is what used to swallow a comma or a
  // space the moment it was typed, so the raw text is its own state and only
  // tidied up when the field is left.
  const [mapsText, setMapsText] = useState(() => prefilled.maps.join(", "));
  // But not *only* here. Opening the library or another tab unmounts this
  // form, and a draft nobody else held used to vanish with it, bringing back
  // whatever the state had from the last Compose. So the draft is kept in the
  // state after each pause in typing and once more on the way out.
  //
  // `sent` is the last draft this form handed over itself. The state answers
  // every hand-over with the same draft as a new object, and adopting that
  // echo would overwrite anything typed while it was on its way; only a draft
  // that differs from it (a reset, a fresh form) is somebody else's and taken.
  const sent = useRef<ContributionDraft | null>(prefilled);
  const pending = useRef<ContributionDraft | null>(null);
  const timer = useRef<number | null>(null);
  const keep = useRef(onKeep);
  useEffect(() => {
    keep.current = onKeep;
  }, [onKeep]);

  useEffect(() => {
    if (sameDraft(prefilled, sent.current)) return;
    sent.current = prefilled;
    setDraft(prefilled);
    setMapsText(prefilled.maps.join(", "));
  }, [prefilled]);

  const cancelKeep = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  };
  const keepNow = () => {
    const next = pending.current;
    cancelKeep();
    if (next === null) return;
    sent.current = next;
    keep.current(next);
  };

  // The way out: whatever was typed since the last pause goes to the state
  // before the form disappears. Refs only, so the first render's closure is
  // as good as the last one's.
  useEffect(
    () => () => {
      const next = pending.current;
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (next !== null) keep.current(next);
    },
    [],
  );

  // The pictures attached to this draft, and the addresses the previews show
  // them from until they are sent.
  const attached = useAttachments();
  const local = useMemo(() => localImages(attached), [attached]);
  const [attachProblem, setAttachProblem] = useState<AttachProblem | null>(null);

  const [stale, setStale] = useState(false);
  const onChange = (next: ContributionDraft) => {
    setDraft(next);
    setStale(true);
    pending.current = next;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(keepNow, KEEP_AFTER_MS);
  };
  const problem = contributionProblem(draft);
  // Checked here rather than in the shared rule: a bound written "1,200+" is
  // fine, it only has to be read as 1200 before it is composed.
  const ratingIssue = ratingProblem(draft);
  const blocked = problem !== null || ratingIssue !== null;

  // After Create the post appears in the preview column, which may be off
  // screen or scrolled down a long guide. Bringing it into view is the only
  // sign the press did anything.
  const postRef = useRef<HTMLDivElement>(null);
  const awaitingPost = useRef(false);
  useEffect(() => {
    if (!post || !awaitingPost.current) return;
    awaitingPost.current = false;
    postRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [post]);

  /** A bound that parses is shown back as bare digits once the field is left. */
  const tidyRating = (key: "ratingMin" | "ratingMax") => {
    const value = parseRating(draft[key]);
    if (typeof value === "number" && String(value) !== draft[key]) {
      onChange({ ...draft, [key]: String(value) });
    }
  };

  const kindOptions: SelectOption<string>[] = KINDS.filter((kind) => kind !== "lesson").map(
    // A lesson is something FAF publishes through its own tutorial API and
    // launches offline; it is not a thing a submission can be.
    (kind) => ({ value: kind, label: t(kindLabel(kind)) }),
  );
  const levelOptions: SelectOption<string>[] = [
    { value: NO_LEVEL, label: t("training.contribute.noLevel") },
    ...LEVELS.map((level) => ({ value: level, label: t(levelLabel(level)) })),
  ];

  const previewResource: TrainingResource = {
    id: "contribution-preview",
    title: draft.title || t("training.contribute.untitled"),
    summary: draft.summary,
    kind: draft.kind,
    level: draft.level,
    url: draft.url,
    imageUrl: "",
    tutorialId: null,
    author,
    ratingMin: null,
    ratingMax: null,
    gameModes: draft.gameModes,
    topics: draft.topics,
    maps: draft.maps,
    factions: draft.factions,
    durationMinutes: null,
    related: [],
    approvedBy: "",
    updatedAt: "",
    recordingUrl: "",
    readable: false,
  };

  return (
    <div className="training-contribute-page">
      <form
        className="training-form training-contribute-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (blocked) return;
          // Compose records the draft too, so a keep still waiting for its
          // pause would only repeat it, and clear the post it is about to get.
          cancelKeep();
          const ready = normaliseRatings({ ...draft, maps: splitMaps(mapsText) });
          setDraft(ready);
          setMapsText(ready.maps.join(", "));
          sent.current = ready;
          awaitingPost.current = true;
          onCompose(ready);
          setStale(false);
        }}
      >
        <header className="training-section-head">
          <div>
            <h3>{t("training.contribute.title")}</h3>
          </div>
        </header>

        {/* Three questions in the order an author answers them: what it is,
            who it is for, and the thing itself. Grouped, a reader sees how far
            through the form they are instead of a column of equal fields. */}
        <fieldset className="training-contribute-section">
          <legend>{t("training.contribute.section.what")}</legend>
          <label className="training-field">
            <span>
              {t("training.contribute.name")} <em>{t("training.required")}</em>
            </span>
            <input
              value={draft.title}
              onChange={(event) => onChange({ ...draft, title: event.target.value })}
              placeholder={t("training.contribute.namePlaceholder")}
              maxLength={120}
            />
          </label>

          {/* One line, and it is what a card in the library shows under the
              title. Without it an accepted entry has nothing to say for itself
              and a maintainer ends up writing one on the author's behalf. */}
          <label className="training-field">
            <span>{t("training.contribute.summary")}</span>
            <input
              value={draft.summary}
              onChange={(event) => onChange({ ...draft, summary: event.target.value })}
              placeholder={t("training.contribute.summaryPlaceholder")}
              maxLength={160}
            />
          </label>

          <div className="training-field-grid">
            <label className="training-field">
              <span>{t("training.contribute.kind")}</span>
              <Select
                value={draft.kind}
                options={kindOptions}
                onChange={(value) => onChange({ ...draft, kind: value as TrainingKind })}
                label={t("training.contribute.kind")}
              />
            </label>
            <label className="training-field">
              <span>{t("training.contribute.level")}</span>
              <Select
                value={draft.level ?? NO_LEVEL}
                options={levelOptions}
                onChange={(value) =>
                  onChange({
                    ...draft,
                    level: value === NO_LEVEL ? null : (value as TrainingLevel),
                  })
                }
                label={t("training.contribute.level")}
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="training-contribute-section">
          <legend>{t("training.contribute.section.audience")}</legend>
          <div className="training-field-grid">
            {/* Text fields, not number ones, for the same reason the review
                form's rating is: a number input is empty mid-edit. */}
            <label className="training-field">
              <span>{t("training.contribute.ratingMin")}</span>
              <input
                value={draft.ratingMin}
                onChange={(event) => onChange({ ...draft, ratingMin: event.target.value })}
                onBlur={() => tidyRating("ratingMin")}
                placeholder="800"
                inputMode="numeric"
                aria-invalid={ratingIssue === "ratingMinInvalid" || ratingIssue === "ratingOrder"}
              />
            </label>
            <label className="training-field">
              <span>{t("training.contribute.ratingMax")}</span>
              <input
                value={draft.ratingMax}
                onChange={(event) => onChange({ ...draft, ratingMax: event.target.value })}
                onBlur={() => tidyRating("ratingMax")}
                placeholder="1200"
                inputMode="numeric"
                aria-invalid={ratingIssue === "ratingMaxInvalid" || ratingIssue === "ratingOrder"}
              />
            </label>
          </div>
          {ratingIssue && (
            <p className="muted training-form-problem" role="alert">
              {t(RATING_PROBLEM_LABELS[ratingIssue])}
            </p>
          )}

          <div className="training-tag-row">
            <MultiSelect
              label={t("training.contribute.topics")}
              options={TOPICS.map((topic) => ({ value: topic, label: t(topicLabel(topic)) }))}
              selected={draft.topics}
              onChange={(topics) => onChange({ ...draft, topics: topics as TrainingTopic[] })}
            />
            <MultiSelect
              label={t("training.contribute.modes")}
              options={modes.map((mode) => ({ value: mode, label: mode }))}
              selected={draft.gameModes}
              onChange={(gameModes) => onChange({ ...draft, gameModes })}
            />
            <MultiSelect
              label={t("training.contribute.factions")}
              options={catalogueFactions()}
              selected={draft.factions}
              onChange={(factions) => onChange({ ...draft, factions })}
            />
            <label className="training-field">
              <span>{t("training.contribute.maps")}</span>
              <input
                value={mapsText}
                onChange={(event) => {
                  // The list follows the text, so the preview and the kept draft
                  // stay current; the text itself is left exactly as typed.
                  setMapsText(event.target.value);
                  onChange({ ...draft, maps: splitMaps(event.target.value) });
                }}
                onBlur={() => setMapsText(splitMaps(mapsText).join(", "))}
                placeholder={t("training.contribute.mapsPlaceholder")}
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="training-contribute-section">
          <legend>{t("training.contribute.section.content")}</legend>
          <label className="training-field">
            <span>{t("training.contribute.url")}</span>
            <input
              value={draft.url}
              onChange={(event) => onChange({ ...draft, url: event.target.value })}
              placeholder="https://www.youtube.com/watch?v=..."
            />
          </label>
          <p className="muted training-form-hint">{t("training.contribute.urlHint")}</p>

          {/* The same editor the dialogs use, minus its preview tab: the preview
              is permanently on screen beside it here, so the toggle would only
              ever hide it. The formatting toolbar stays, because that is a
              different thing and an author writing a guide wants it. */}
          <div className="training-editor">
            <MarkdownField
              label={t("training.contribute.body")}
              value={draft.body}
              onChange={(body) => onChange({ ...draft, body })}
              placeholder={t("training.contribute.bodyPlaceholder")}
              ownPreview={false}
              rows={16}
              accept={ACCEPTED_TYPES}
              onAttach={(files) => {
                const inserted: string[] = [];
                let problem: AttachProblem | null = null;
                for (const file of files) {
                  const result = attach(file);
                  if ("problem" in result) problem = result.problem;
                  else inserted.push(imageMarkdown(result.attachment.name));
                }
                setAttachProblem(problem);
                return inserted.join("\n\n");
              }}
            />
          </div>
          <p className="muted training-form-hint">{t("training.contribute.imagesHint")}</p>
          {attachProblem && (
            <p className="muted training-form-problem" role="alert">
              {t(ATTACH_PROBLEM_LABELS[attachProblem])}
            </p>
          )}

          {/* What is attached, so a picture can be taken out again without
              hunting for its line in the text. */}
          {attached.length > 0 && (
            <ul className="training-attachments" aria-label={t("training.contribute.images")}>
              {attached.map((attachment) => (
                <li key={attachment.name} className="training-attachment">
                  <img src={attachment.url} alt="" aria-hidden />
                  <span className="training-attachment-name" title={attachment.name}>
                    {attachment.name}
                  </span>
                  <span className="muted training-attachment-size">{fileSize(attachment.size)}</span>
                  <button
                    type="button"
                    className="training-attachment-remove"
                    title={t("training.contribute.removeImage", { name: attachment.name })}
                    aria-label={t("training.contribute.removeImage", { name: attachment.name })}
                    onClick={() => {
                      detach(attachment.name);
                      onChange({ ...draft, body: withoutImage(draft.body, attachment.name) });
                    }}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        {problem && (
          <p className="muted training-form-problem">{t(contributionProblemLabel(problem))}</p>
        )}

        <div className="training-form-actions">
          <Button type="submit" variant="primary" disabled={blocked}>
            <Icon name="edit" size={15} /> {t("training.contribute.compose")}
          </Button>
          <Button
            onClick={() => {
              // A keep sent after the reset would bring the old text back, and
              // the fresh draft has to be adopted even when it happens to match
              // the last one kept (an author who had emptied every field).
              cancelKeep();
              sent.current = null;
              clearAttachments();
              setAttachProblem(null);
              onReset();
            }}
          >
            {t("training.contribute.reset")}
          </Button>
        </div>
      </form>

      {/* Right: what the author is making, as it is made. The card is what the
          library will show; the rendered guide is what a reader will read. */}
      <aside className="training-contribute-preview">
        <h4>{t("training.contribute.preview")}</h4>

        {/* The composed post leads the column rather than trailing the whole
            guide: Send and Copy are what the author is looking for once it
            exists, and below a long preview they were out of sight. */}
        {post && !stale && (
          <div ref={postRef} className="training-contribute-post">
            {/* A browser link carries text and nothing else, so pictures only
                travel when the client sends the guide itself. */}
            {onSubmit === null && attached.length > 0 && (
              <p className="muted training-form-problem">
                {t("training.contribute.imagesNeedSignIn")}
              </p>
            )}
            <PostPreview
              post={post}
              destination="github"
              submit={guides.submit}
              base={{ local }}
              onSubmit={onSubmit === null ? null : () => onSubmit(normaliseRatings(draft))}
            />
          </div>
        )}

        {/* The card exactly as the library will draw it: the same component,
            so a build order shows its map and anything else its kind's
            cover. What the author sees is what a reader will see. */}
        <div className="training-contribute-card">
          <TrainingCard resource={previewResource} onOpen={ignore} onSelect={ignore} />
        </div>
        <div className="training-preview-tags">
          <div className="training-card-tags">
            <span className="training-chip">{t(kindLabel(draft.kind))}</span>
            {draft.level && <span className="training-chip">{t(levelLabel(draft.level))}</span>}
            {draft.topics.map((topic) => (
              <span className="training-tag" key={topic}>
                {t(topicLabel(topic))}
              </span>
            ))}
            {draft.gameModes.map((mode) => (
              <span className="training-tag" key={`mode-${mode}`}>
                {mode}
              </span>
            ))}
            {draft.maps.map((map) => (
              <span className="training-tag" key={`map-${map}`}>
                {map}
              </span>
            ))}
          </div>
        </div>

        {draft.body.trim() ? (
          <div className="training-preview-body">
            <Markdown source={draft.body} base={{ local }} />
          </div>
        ) : (
          <p className="muted training-preview-empty">{t("training.contribute.previewEmpty")}</p>
        )}

      </aside>
    </div>
  );
}
