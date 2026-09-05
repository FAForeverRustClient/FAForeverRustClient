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

import { useEffect, useState } from "react";
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
  TrainingTopic,
} from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { FACTION_NAMES } from "../../shared/factions";
import { contributionProblem } from "../../shared/trainingRules";
import { Markdown } from "./markdown";
import { MarkdownField } from "./MarkdownField";
import { PostPreview } from "./PostPreview";
import {
  COMMON_MODES,
  KINDS,
  LEVELS,
  contributionProblemLabel,
  kindLabel,
  levelLabel,
  topicLabel,
  TOPICS,
} from "./trainingPresentation";

const NO_LEVEL = "";

/**
 * The catalogue stores factions as lowercase slugs; the labels are proper
 * nouns, so they are the same in every language (see `shared/factions.ts`).
 */
const CATALOGUE_FACTIONS = [1, 2, 3, 4].map((id) => ({
  value: FACTION_NAMES[id].toLowerCase(),
  label: FACTION_NAMES[id],
}));

interface Props {
  /** The empty draft the service opened the form with. */
  prefilled: ContributionDraft;
  post: ForumPost | null;
  guides: GuidesState;
  onCompose: (draft: ContributionDraft) => void;
  /** Send it straight to the repository, or `null` when the client cannot. */
  onSubmit: ((draft: ContributionDraft) => void) | null;
  onReset: () => void;
}

export function ContributePanel({
  prefilled,
  post,
  guides,
  onCompose,
  onSubmit,
  onReset,
}: Props) {
  const { t } = useTranslation();
  // Owned locally while it is being written: a controlled textarea driven
  // through the backend would round-trip every keystroke.
  const [draft, setDraft] = useState(prefilled);
  useEffect(() => setDraft(prefilled), [prefilled]);
  const [stale, setStale] = useState(false);
  const onChange = (next: ContributionDraft) => {
    setDraft(next);
    setStale(true);
  };
  const problem = contributionProblem(draft);

  const kindOptions: SelectOption<string>[] = KINDS.filter((kind) => kind !== "lesson").map(
    // A lesson is something FAF publishes through its own tutorial API and
    // launches offline; it is not a thing a submission can be.
    (kind) => ({ value: kind, label: t(kindLabel(kind)) }),
  );
  const levelOptions: SelectOption<string>[] = [
    { value: NO_LEVEL, label: t("training.contribute.noLevel") },
    ...LEVELS.map((level) => ({ value: level, label: t(levelLabel(level)) })),
  ];

  return (
    <div className="training-contribute-page">
      <form
        className="training-form training-contribute-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem) return;
          onCompose(draft);
          setStale(false);
        }}
      >
        <header className="training-section-head">
          <div>
            <h3>{t("training.contribute.title")}</h3>
            <p className="muted">{t("training.contribute.lead")}</p>
          </div>
        </header>

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
          {/* Text fields, not number ones, for the same reason the review
              form's rating is: a number input is empty mid-edit. */}
          <label className="training-field">
            <span>{t("training.contribute.ratingMin")}</span>
            <input
              value={draft.ratingMin}
              onChange={(event) => onChange({ ...draft, ratingMin: event.target.value })}
              placeholder="800"
              inputMode="numeric"
            />
          </label>
          <label className="training-field">
            <span>{t("training.contribute.ratingMax")}</span>
            <input
              value={draft.ratingMax}
              onChange={(event) => onChange({ ...draft, ratingMax: event.target.value })}
              placeholder="1200"
              inputMode="numeric"
            />
          </label>
        </div>

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
          />
        </div>

        <div className="training-tag-row">
          <MultiSelect
            label={t("training.contribute.topics")}
            options={TOPICS.map((topic) => ({ value: topic, label: t(topicLabel(topic)) }))}
            selected={draft.topics}
            onChange={(topics) => onChange({ ...draft, topics: topics as TrainingTopic[] })}
          />
          <MultiSelect
            label={t("training.contribute.modes")}
            options={COMMON_MODES.map((mode) => ({ value: mode, label: mode }))}
            selected={draft.gameModes}
            onChange={(gameModes) => onChange({ ...draft, gameModes })}
          />
          <MultiSelect
            label={t("training.contribute.factions")}
            options={CATALOGUE_FACTIONS}
            selected={draft.factions}
            onChange={(factions) => onChange({ ...draft, factions })}
          />
          <label className="training-field">
            <span>{t("training.contribute.maps")}</span>
            <input
              value={draft.maps.join(", ")}
              onChange={(event) =>
                onChange({
                  ...draft,
                  maps: event.target.value
                    .split(",")
                    .map((map) => map.trim())
                    .filter((map) => map !== ""),
                })
              }
              placeholder={t("training.contribute.mapsPlaceholder")}
            />
          </label>
        </div>

        {problem && (
          <p className="muted training-form-problem">{t(contributionProblemLabel(problem))}</p>
        )}

        <div className="training-form-actions">
          <Button type="submit" variant="primary" disabled={problem !== null}>
            <Icon name="edit" size={15} /> {t("training.contribute.compose")}
          </Button>
          <Button onClick={onReset}>{t("training.contribute.reset")}</Button>
        </div>
      </form>

      {/* Right: what the author is making, as it is made. The card is what the
          library will show; the rendered guide is what a reader will read. */}
      <aside className="training-contribute-preview">
        <h4>{t("training.contribute.preview")}</h4>

        <article className="training-preview-card">
          <strong>{draft.title || t("training.contribute.untitled")}</strong>
          {draft.summary && <p className="muted">{draft.summary}</p>}
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
        </article>

        {draft.body.trim() ? (
          <div className="training-preview-body">
            <Markdown source={draft.body} />
          </div>
        ) : (
          <p className="muted training-preview-empty">{t("training.contribute.previewEmpty")}</p>
        )}

        {post && !stale && (
          <PostPreview
            post={post}
            destination="github"
            submit={guides.submit}
            onSubmit={onSubmit === null ? null : () => onSubmit(draft)}
          />
        )}
      </aside>
    </div>
  );
}
