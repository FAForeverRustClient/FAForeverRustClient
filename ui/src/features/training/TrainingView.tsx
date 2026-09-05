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

import { useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { SectionTabs, type SectionTab } from "../../design-system/SectionTabs";
import type { AppCommand, TrainingCommand, TrainingResource } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { openHttpsUrl } from "../../shared/externalLinks";
import { recommendedResources } from "../../shared/trainingRules";
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
import { BASIC_TOPICS, renderedPage, topicHint, topicLabel } from "./trainingPresentation";
import "./training.css";

const send = (command: TrainingCommand) =>
  ipc.send({ kind: "Training", command } satisfies AppCommand);

/** Open the review form with nothing named: the hero's own entry point. */
const openBlankReview = () =>
  send({ type: "openReview", payload: { replayUid: null, localPath: null } });

type Section = "hub" | "library" | "lessons" | "trainers" | "contribute" | "pending";

export function TrainingView() {
  const { t } = useTranslation();
  const state = useAppStore((store) => store.state.training);
  const guides = useAppStore((store) => store.state.guides);
  const [section, setSection] = useState<Section>("hub");
  const railRef = useRef<HTMLElement>(null);

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
  // component. That is also what lets the replays tab prefill it and switch
  // here in one command pair.
  useEffect(() => {
    if (state.review !== null) setSection("hub");
  }, [state.review]);

  const recommended = recommendedResources(state.resources, state.recommended);
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
   * than no explanation. What is shown is the single strongest overlap, which
   * is the part a player can agree or disagree with.
   */
  const reasonFor = (resource: TrainingResource, maps: string[], modes: string[]): string | null => {
    const map = maps.find((mine) =>
      resource.maps.some((theirs) => theirs.toLowerCase().includes(mine.toLowerCase())),
    );
    if (map) return t("training.reason.map", { map });
    const mode = modes.find((mine) =>
      resource.gameModes.some((theirs) => theirs.toLowerCase() === mine.toLowerCase()),
    );
    if (mode) return t("training.reason.mode", { mode });
    return null;
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

  const sections: SectionTab<Section>[] = [
    { id: "hub", label: t("training.section.hub") },
    { id: "library", label: t("training.section.library"), count: state.resources.length },
    {
      id: "lessons",
      label: t("training.section.lessons"),
      // No count: there is nothing to count, and a zero beside a tab reads as
      // a bug rather than as an answer.
      count: undefined,
    },
    { id: "trainers", label: t("training.section.trainers"), count: state.trainers.length },
    { id: "contribute", label: t("training.section.contribute") },
    // No count when the viewer cannot see the queue: a number would be a fact
    // about a list the tab is about to say they may not read.
    {
      id: "pending",
      label: t("training.section.pending"),
      count: canModerate ? guides.submissions.length : undefined,
    },
  ];

  const failed = state.status.type === "failed" ? state.status.payload.reason : null;

  return (
    <div className="training-view">
      <header className="training-header">
        <div>
          <span className="training-eyebrow">{t("training.eyebrow")}</span>
          <h2>{t("training.title")}</h2>
        </div>
        <div className="training-header-actions">
          {/* Says which catalogue is on screen. A client running on the
              shipped seed shows a fraction of what a published manifest
              carries, and looking thin for no stated reason is worse than
              saying so. */}
          <span className="muted training-source">
            {t(
              state.source === "remote"
                ? "training.source.remote"
                : "training.source.bundled",
            )}
          </span>
          <Button onClick={() => send({ type: "load" })} disabled={state.status.type === "loading"}>
            <Icon name="refresh" size={15} /> {t("training.refresh")}
          </Button>
        </div>
      </header>

      <SectionTabs
        active={section}
        ariaLabel={t("training.title")}
        items={sections}
        onChange={setSection}
      />

      {failed && (
        <p className="surface training-state muted">
          <span>{t("training.loadFailed", { reason: failed })}</span>
          <Button onClick={() => send({ type: "load" })}>
            <Icon name="refresh" size={15} /> {t("training.tryAgain")}
          </Button>
        </p>
      )}

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
            onFindTrainer={
              state.trainers.length === 0 ? null : () => setSection("trainers")
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
              <p className="surface training-state muted">
                <span>
                  {state.status.type === "loading"
                    ? t("training.loading")
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
                    reason={reasonFor(resource, state.profile.maps, state.profile.gameModes)}
                    onOpen={open}
                    onSelect={(picked) =>
                      send({ type: "select", payload: { resourceId: picked.id } })
                    }
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
                      send({ type: "setQuery", payload: { query: { ...state.query, topic } } });
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
          query={state.query}
          profile={state.profile}
          myRating={myRating}
          onQuery={(query) => send({ type: "setQuery", payload: { query } })}
          onOpen={open}
          onSelect={(resource) => send({ type: "select", payload: { resourceId: resource.id } })}
        />
      )}

      {/* Empty, and honestly so. FAF's tutorial API is no longer read here: it
          flags entries playable whose maps no longer start anything, and its
          link categories are not lessons at all. A lesson is something the
          client can launch, nobody has authored one yet, and when somebody
          does it arrives through the catalogue like everything else. The
          launch path itself is finished and waiting. */}
      {section === "lessons" && (
        <section className="surface-panel training-soon">
          <Icon name="play" size={26} />
          <h3>{t("training.lessons.soon")}</h3>
          <p className="muted">{t("training.lessons.soonLead")}</p>
          <div className="training-queue-actions">
            <Button variant="primary" onClick={() => setSection("library")}>
              {t("training.lessons.soonLibrary")}
            </Button>
          </div>
        </section>
      )}

      {section === "trainers" && (
        <TrainerTiles trainers={state.trainers} discordUrl={state.links.discordUrl} />
      )}

      {section === "contribute" && state.contribution && (
        <ContributePanel
          prefilled={state.contribution}
          post={state.contributionPost}
          guides={guides}
          onCompose={(draft) => send({ type: "composeContribution", payload: { draft } })}
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

      {selected && (
        <ResourceDetail
          resource={selected}
          resources={state.resources}
          guide={state.document}
          onOpen={open}
          onRead={(resource) => send({ type: "readGuide", payload: { resourceId: resource.id } })}
          onSelect={(resource) => send({ type: "select", payload: { resourceId: resource.id } })}
          onRequestReview={() => {
            send({ type: "select", payload: { resourceId: null } });
            openBlankReview();
          }}
          onClose={() => send({ type: "select", payload: { resourceId: null } })}
        />
      )}

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
