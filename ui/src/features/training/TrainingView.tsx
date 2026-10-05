// Training: the client's front door to learning FAF.
//
// This tab was the tutorials list, and the rename is the point rather than
// cosmetic. FAF has plenty of training material; what it has never had is a
// place where a player finds out that it exists, where it is, and which of it
// is for them. So the tab's job is wider than a list: recommend, route, and
// collect.
//
// Everything it shows comes from the catalogue repository. FAF's tutorial API
// is deliberately not read here: it flags entries playable whose maps no longer
// start anything, and its "Video tutorials" and "Written guides" categories are
// links rather than lessons. None of that could be corrected without a client
// release, which is the thing this design exists to avoid. Anything of FAF's
// worth keeping belongs in the catalogue, in a commit, with tags on it.
//
// Six sections, in the order a player meets them:
//
//   HUB        hero (replay review, the community) + recommended for you +
//              learn the basics
//   LIBRARY    the whole catalogue, with filters
//   LESSONS    scenarios played inside the game, which the client can start.
//              Empty today: FAF's tutorial API carries links rather than
//              playable maps, and authoring real ones is design work nobody
//              has done yet. The tab stays and says so, because "coming" is
//              information and an absent tab is not.
//   TRAINERS   the training team, as tiles
//   CONTRIBUTE writing a submission, editor beside a live preview
//   PENDING    the submission queue, for whoever maintains the catalogue
//
// Everything that is a rule lives in Rust: which resources are recommended and
// in what order, what a review request must contain, what the composed post
// says. This file selects state and dispatches commands.

import { useEffect, useLayoutEffect, useRef, type UIEvent } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { SectionTabs, sectionPanelProps, type SectionTab } from "../../design-system/SectionTabs";
import type { AppCommand, TrainingCommand, TrainingResource } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { openHttpsUrl } from "../../shared/externalLinks";
import { plainError } from "../../shared/plainError";
import {
  recommendationReason,
  recommendedResources,
  type RecommendationReason,
} from "../../shared/rules/trainingRules";
import { EMPTY_TRAINING_QUERY } from "../../shared/trainingQuery";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import { ContributePanel } from "./ContributePanel";
import { ReplayReviewDialog } from "./ReplayReviewDialog";
import { ResourceDetail } from "./ResourceDetail";
import { TrainingCard } from "./TrainingCard";
import { TrainingHero } from "./TrainingHero";
import { TrainingLibrary } from "./TrainingLibrary";
import { TrainerTiles } from "./TrainerTiles";
import { GuidesQueue } from "./GuidesQueue";
import { modeOptions } from "./libraryGroups";
import { BASIC_TOPICS, renderedPage, topicHint, topicLabel } from "./trainingPresentation";
import { useTrainingView, type TrainingSection } from "./trainingViewState";
import "./training.css";

const send = (command: TrainingCommand) =>
  ipc.send({ kind: "Training", command } satisfies AppCommand);

/** Open the review form with nothing named: the hero's own entry point. */
const openBlankReview = () =>
  send({ type: "openReview", payload: { replayUid: null, localPath: null } });

/** Ties the section tabs to the panel under them, for assistive technology. */
const SECTION_TABS_ID = "training-section";

export function TrainingView() {
  const { t } = useTranslation();
  const state = useAppStore((store) => store.state.training);
  const guides = useAppStore((store) => store.state.guides);
  const replayScan = useAppStore((store) => store.state.replays.localStatus.type);
  // Kept outside the component: leaving for the chat unmounts this view, and
  // an open guide's back button has to return to the section it was opened
  // from rather than to the overview a fresh mount would start on.
  const section = useTrainingView((view) => view.section);
  const setSection = useTrainingView((view) => view.setSection);
  const rememberScroll = useTrainingView((view) => view.rememberScroll);
  const railRef = useRef<HTMLElement>(null);
  // The view is its own scroller (`overflow-y: auto` in training.css).
  const viewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // One load covers the catalogue and the recommendations: the service
    // sequences them, because the recommendations are computed from what the
    // catalogue produced.
    if (useAppStore.getState().state.training.status.type === "idle") {
      send({ type: "load" });
    }
    // The catalogue's repository is a separate concern with its own identity,
    // so it announces itself separately: what the client was configured with,
    // and whether a stored GitHub session is still good.
    ipc.send({ kind: "Guides", command: { type: "restore" } });
  }, []);

  // Read the queue every time it is opened, not once at startup.
  //
  // The catalogue is a near-static document and is loaded once; the queue is
  // the opposite, and a submission opened five minutes ago has to be there. A
  // list that was accurate when the client started is the one thing this tab
  // cannot afford, because it is the tab where somebody is waiting for an
  // answer.
  useEffect(() => {
    if (section === "pending") ipc.send({ kind: "Guides", command: { type: "loadQueue" } });
  }, [section]);

  // The contribution form is a tab now, but the draft still lives in the slice:
  // that is what lets the service compose the submission from it and what keeps
  // a half-written guide alive while the player looks something up in the
  // library. Opening the tab opens a draft if there is not one already.
  useEffect(() => {
    if (section === "contribute" && state.contribution === null) {
      send({ type: "openContribution" });
    }
  }, [section, state.contribution]);

  // The review dialog is opened from three places (the hero, a resource, the
  // replays tab), so it is the slice that decides whether it is open, not this
  // component. It is drawn over whichever section is showing: an earlier
  // version also switched to the overview whenever it opened, which took a
  // reader asking about a guide out of the library and left them on the
  // overview once the dialog closed.

  const recommended = recommendedResources(state.resources, state.recommended);
  // The rail is ranked against the player's recent replays, which are scanned
  // after the catalogue is on screen. Until that scan has run, "nothing to
  // recommend" would be a verdict on a profile that has not been read yet.
  const recommendationsPending =
    state.status.type === "idle" ||
    state.status.type === "loading" ||
    (state.status.type === "ready" && (replayScan === "idle" || replayScan === "loading"));
  // A count is only an answer once the list behind it has arrived; a zero
  // during the first load reads as "there is nothing here".
  const catalogueKnown = state.status.type === "ready" || state.resources.length > 0;
  // Whether the queue has anything to show this viewer. Being signed in, not
  // being a collaborator: GitHub decides what a write is allowed to do, and it
  // says so at the point of the write.
  const canModerate = guides.auth.type === "signedIn";
  const myRating = state.profile.rating;
  const selected =
    state.selectedId === null
      ? undefined
      : state.resources.find((resource) => resource.id === state.selectedId);

  /**
   * Why a card is in the rail, when the reason is one the player can check.
   *
   * The score itself is never shown: a number nobody can interpret is worse
   * than no explanation. What is shown is the single strongest overlap, read
   * off the same terms the ranking adds up (`recommendationReason`), so the
   * sentence cannot name a reason the ranking did not weigh.
   */
  const reasonText = (reason: RecommendationReason | null): string | null => {
    if (reason === null) return null;
    switch (reason.type) {
      case "rating":
        // `global` is the overall rating under its leaderboard name, which is
        // not a mode anyone says they play.
        return reason.mode === null || reason.mode === "global"
          ? t("training.reason.rating", { rating: reason.rating })
          : t("training.reason.ratingIn", { mode: reason.mode, rating: reason.rating });
      case "map":
        return t("training.reason.map", { map: reason.map });
      case "mode":
        return t("training.reason.mode", { mode: reason.mode });
    }
  };

  /** Open a resource. Everything in the catalogue is a destination today. */
  const open = (resource: TrainingResource) => {
    if (!resource.url) return;
    // The catalogue stores the raw address, because that is the one the client
    // reads itself. Handing that to a browser would show a build order as a
    // wall of monospace: `raw.githubusercontent.com` serves text/plain, and
    // only the `blob` address is rendered.
    void openHttpsUrl(renderedPage(resource.url));
  };

  const sections: SectionTab<TrainingSection>[] = [
    { id: "hub", label: t("training.section.hub") },
    {
      id: "library",
      label: t("training.section.library"),
      count: catalogueKnown ? state.resources.length : undefined,
    },
    {
      id: "lessons",
      label: t("training.section.lessons"),
      // No count: there is nothing to count, and a zero beside a tab reads as
      // a bug rather than as an answer.
      count: undefined,
    },
    {
      id: "trainers",
      label: t("training.section.trainers"),
      // No zero either: an empty team gets its own explanation on the page.
      count: catalogueKnown && state.trainers.length > 0 ? state.trainers.length : undefined,
    },
    { id: "contribute", label: t("training.section.contribute") },
    // No count when the viewer cannot see the queue: a number would be a fact
    // about a list the tab is about to say they may not read.
    {
      id: "pending",
      label: t("training.section.pending"),
      count:
        canModerate && (guides.status.type === "ready" || guides.submissions.length > 0)
          ? guides.submissions.length
          : undefined,
    },
  ];

  /**
   * Open an entry, one level down rather than one tab across.
   *
   * The section a reader is in does not change: they are still in the library,
   * or still on the hub, looking at one of its entries. So the entry replaces
   * the section's content and back returns to it, with no seventh tab
   * appearing and disappearing in the bar as they browse.
   *
   * Which entry is open lives in the backend's state, so this is only a
   * command. An earlier version also flipped a local section to a `detail`
   * value, which raced that round trip: the entry had not arrived by the time
   * the render ran, the guard sent the reader back, and opening a guide took
   * two clicks.
   */
  const select = (resource: TrainingResource) =>
    send({ type: "select", payload: { resourceId: resource.id } });

  const closeDetail = () => send({ type: "select", payload: { resourceId: null } });

  // Scroll, around an open entry. An entry opens at its top rather than at
  // whatever height the list had been scrolled to, and back returns to that
  // height rather than to the top of the list. The list's offset is
  // remembered while it is on screen, outside the component, so it also
  // survives leaving the tab with an entry open.
  //
  // A layout effect, as the leaderboard's table reset is, so neither the
  // entry nor the list is painted at the wrong offset first. The restore is
  // repeated a frame later because the library's shelves measure their row
  // length in their own layout effects, and the page is only at full height
  // once that has settled.
  const selectedId = selected?.id ?? null;
  const shownEntry = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    const view = viewRef.current;
    const before = shownEntry.current;
    shownEntry.current = selectedId;
    if (!view || before === selectedId) return;
    if (selectedId !== null) {
      view.scrollTop = 0;
      return;
    }
    const target = useTrainingView.getState().scroll[section] ?? 0;
    view.scrollTop = target;
    const frame = requestAnimationFrame(() => {
      view.scrollTop = target;
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId, section]);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    if (selectedId === null) rememberScroll(section, event.currentTarget.scrollTop);
  };

  const failed = state.status.type === "failed" ? state.status.payload.reason : null;

  return (
    <div className="training-view" ref={viewRef} onScroll={onScroll}>
      {/* No page title above the tabs. No other tab carries one, and the
          sidebar already says where the reader is; the section tabs are the
          top of the page, with the catalogue's state at the far end of their
          rule, the way the library's tally rides its kind tabs. */}
      <div className="training-tabs-row">
        <SectionTabs
          active={section}
          ariaLabel={t("training.title")}
          className="training-section-tabs"
          idPrefix={SECTION_TABS_ID}
          items={sections}
          onChange={(next) => {
            // An open entry belongs to the section it was opened from. Carrying
            // it across to another tab would show a build order under
            // "Trainers".
            closeDetail();
            setSection(next);
          }}
        />
        <div className="training-tabs-tools">
          {/* Says which catalogue is on screen. A client running on the
              shipped seed shows a fraction of what a published manifest
              carries, and looking thin for no stated reason is worse than
              saying so. */}
          <span className="muted training-source">
            {t(
              state.source === "remote"
                ? "training.source.remote"
                : state.source === "cached"
                  ? "training.source.cached"
                  : "training.source.bundled",
            )}
          </span>
          <button
            type="button"
            className="training-icon-button"
            onClick={() => send({ type: "load" })}
            disabled={state.status.type === "loading"}
            title={t("training.refresh")}
            aria-label={t("training.refresh")}
          >
            <Icon
              name="refresh"
              size={15}
              className={state.status.type === "loading" ? "spin" : undefined}
            />
          </button>
        </div>
      </div>

      {failed && (
        <p className="surface training-state muted">
          <span title={failed}>{t("training.loadFailed", { reason: plainError(failed) })}</span>
          <Button onClick={() => send({ type: "load" })}>
            <Icon name="refresh" size={15} /> {t("training.tryAgain")}
          </Button>
        </p>
      )}

      {/* One level down, not one tab across: an open entry replaces the
          section it was opened from rather than adding a tab of its own,
          and back returns to exactly what the reader was looking at. */}
      <div className="training-panel" {...sectionPanelProps(SECTION_TABS_ID, section)}>
      {selected ? (
        <ResourceDetail
          resource={selected}
          resources={state.resources}
          guide={state.document}
          onOpen={open}
          onRead={(resource) => send({ type: "readGuide", payload: { resourceId: resource.id } })}
          onSelect={select}
          // The entry stays open under the dialog, so closing it returns the
          // reader to the guide they were asking about, and back from there
          // to the section it was opened from.
          onRequestReview={openBlankReview}
          onClose={closeDetail}
        />
      ) : (
        <>
        {section === "hub" && (
          <div className="training-hub">
            <TrainingHero
              links={state.links}
              profile={state.profile}
              hasRecommendations={recommended.length > 0}
              onRequestReview={openBlankReview}
              onShowRecommended={() =>
                railRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            />

            <section className="training-rail-section" ref={railRef}>
              <header className="training-section-head">
                <div>
                  <h3>{t("training.recommended.title")}</h3>
                  <p className="muted">{t("training.recommended.lead")}</p>
                </div>
              </header>
              {recommended.length === 0 ? (
                <p className="surface training-state muted" aria-live="polite">
                  <span>
                    {state.status.type === "idle" || state.status.type === "loading"
                      ? t("training.loading")
                      : recommendationsPending
                        ? t("training.recommended.pending")
                        : t("training.recommended.empty")}
                  </span>
                  <Button onClick={() => setSection("library")}>
                    {t("training.recommended.browse")}
                  </Button>
                </p>
              ) : (
                <div className="training-rail">
                  {recommended.map((resource) => (
                    <TrainingCard
                      key={resource.id}
                      resource={resource}
                      reason={reasonText(recommendationReason(resource, state.profile))}
                      onOpen={open}
                      onSelect={select}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="training-basics">
              <header className="training-section-head">
                <div>
                  <h3>{t("training.basics.title")}</h3>
                  <p className="muted">{t("training.basics.lead")}</p>
                </div>
              </header>
              <div className="training-basics-grid">
                {BASIC_TOPICS.map((topic) => {
                  const count = state.resources.filter((resource) =>
                    resource.topics.includes(topic),
                  ).length;
                  return (
                    <button
                      type="button"
                      key={topic}
                      className="training-basic-card"
                      onClick={() => {
                        // A fresh query holding only the topic, so the library
                        // shows exactly the entries this tile counted. Keeping
                        // an old search or kind tab here turned "Economy (12)"
                        // into three entries.
                        send({
                          type: "setQuery",
                          payload: { query: { ...EMPTY_TRAINING_QUERY, topic } },
                        });
                        setSection("library");
                      }}
                    >
                      <strong>{t(topicLabel(topic))}</strong>
                      <span className="muted">{t(topicHint(topic))}</span>
                      <span className="training-basic-count">
                        {t("training.basics.count", { count })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {section === "library" && (
          <TrainingLibrary
            resources={state.resources}
            loading={state.status.type === "idle" || state.status.type === "loading"}
            onReload={() => send({ type: "load" })}
            query={state.query}
            profile={state.profile}
            myRating={myRating}
            onQuery={(query) => send({ type: "setQuery", payload: { query } })}
            onOpen={open}
            onSelect={select}
          />
        )}

        {/* Empty, and honestly so. FAF's tutorial API is no longer read here: it
            flags entries playable whose maps no longer start anything, and its
            link categories are not lessons at all. A lesson is something the
            client can launch and nobody has authored one, so the text says
            that and promises no date. */}
        {section === "lessons" && (
          <section className="surface-panel training-soon">
            <Icon name="play" size={26} />
            <h3>{t("training.lessons.soon")}</h3>
            <p className="muted">{t("training.lessons.soonLead")}</p>
            <div className="training-queue-actions">
              <Button variant="primary" onClick={() => setSection("library")}>
                {t("training.lessons.soonLibrary")}
              </Button>
              {/* The written tutorials FAF already has, when the catalogue
                  names where they live. */}
              {state.links.wikiUrl && (
                <Button onClick={() => void openHttpsUrl(state.links.wikiUrl)}>
                  <Icon name="external" size={15} /> {t("training.lessons.wiki")}
                </Button>
              )}
            </div>
          </section>
        )}

        {section === "trainers" && (
          <TrainerTiles
            trainers={state.trainers}
            discordUrl={state.links.discordUrl}
            loading={state.status.type === "idle" || state.status.type === "loading"}
          />
        )}

        {section === "contribute" && state.contribution && (
          <ContributePanel
            prefilled={state.contribution}
            post={state.contributionPost}
            guides={guides}
            modes={modeOptions(state.resources)}
            onCompose={(draft) => send({ type: "composeContribution", payload: { draft } })}
            onKeep={(draft) => send({ type: "changeContribution", payload: { draft } })}
            onSubmit={
              // Only offered when the client can actually open the issue.
              // Everybody else gets the same submission prefilled in a browser,
              // which produces a byte-identical issue.
              guides.auth.type === "signedIn"
                ? (draft) =>
                    ipc.send({ kind: "Guides", command: { type: "submit", payload: { draft } } })
                : null
            }
            onReset={() => {
              send({ type: "closeContribution" });
              send({ type: "openContribution" });
            }}
          />
        )}

        {section === "pending" && (
          <GuidesQueue state={guides} discordUrl={state.links.discordUrl} />
        )}
      </>
      )}
      </div>

      {state.review && (
        <ReplayReviewDialog
          prefilled={state.review}
          post={state.reviewPost}
          onCompose={(draft) => send({ type: "composeReview", payload: { draft } })}
          onClose={() => send({ type: "closeReview" })}
        />
      )}

    </div>
  );
}
