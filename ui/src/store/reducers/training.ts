// Twin of `faf_domain::state::training::reduce`. Pinned by the conformance
// fixture (`reducer.conformance.test.ts`), so a transition that drifts from the
// Rust one fails a test rather than shipping.

import type {
  LessonRecord,
  LessonScore,
  TrainingDocument,
  TrainingEvent,
  TrainingState,
} from "../../ipc/bindings";

/** Twin of `TrainingDocument::default`: nothing read, for nobody. */
const NO_DOCUMENT: TrainingDocument = {
  resourceId: "",
  markdown: "",
  status: { type: "idle" },
  recording: "",
  recordingStatus: { type: "idle" },
};

/** Twin of `LessonScore::beats`: more stars, then the quicker run. */
function beats(score: LessonScore, other: LessonScore): boolean {
  return (
    score.stars > other.stars || (score.stars === other.stars && score.seconds < other.seconds)
  );
}

/** Twin of `record_run`: the record after one more finished run. */
function recordRun(previous: LessonRecord | undefined, score: LessonScore): LessonRecord {
  if (!previous) return { best: score, last: score, runs: 1 };
  return {
    best: beats(score, previous.best) ? score : previous.best,
    last: score,
    runs: previous.runs + 1,
  };
}

export function reduceTraining(state: TrainingState, event: TrainingEvent): TrainingState {
  switch (event.type) {
    case "loading":
      return { ...state, status: { type: "loading" } };
    case "loaded": {
      const { resources, trainers, links, source } = event.payload;
      // A detail pane open on an entry the reload dropped would keep showing a
      // resource the catalogue no longer has.
      const stillPresent = resources.some((resource) => resource.id === state.selectedId);
      return {
        ...state,
        resources,
        trainers,
        links,
        source,
        status: { type: "ready" },
        selectedId: stillPresent ? state.selectedId : null,
      };
    }
    case "loadFailed":
      return { ...state, status: { type: "failed", payload: { reason: event.payload.reason } } };
    case "queryChanged":
      return { ...state, query: event.payload.query };
    case "selected": {
      // A document belongs to the entry it was opened from. Leaving the last
      // one in place would render one guide's text under the next one's title
      // for as long as the read takes.
      const resourceId = event.payload.resourceId;
      const document =
        state.document.resourceId === (resourceId ?? "") ? state.document : NO_DOCUMENT;
      return { ...state, selectedId: resourceId, document };
    }
    case "guideReading":
      return {
        ...state,
        document: {
          ...NO_DOCUMENT,
          resourceId: event.payload.resourceId,
          status: { type: "loading" },
        },
      };
    // A reply for an entry the reader has already left is dropped rather than
    // shown: by the time it arrives the title above it belongs to something
    // else.
    case "guideRead":
      return state.document.resourceId === event.payload.resourceId
        ? {
            ...state,
            document: {
              ...state.document,
              markdown: event.payload.markdown,
              status: { type: "ready" },
            },
          }
        : state;
    case "guideFailed":
      return state.document.resourceId === event.payload.resourceId
        ? {
            ...state,
            document: {
              ...state.document,
              status: { type: "failed", payload: { reason: event.payload.reason } },
            },
          }
        : state;
    // A recording can arrive for an entry that carries no prose at all, so this
    // claims the document rather than assuming a guide already did.
    case "recordingReading":
      return {
        ...state,
        document:
          state.document.resourceId === event.payload.resourceId
            ? { ...state.document, recording: "", recordingStatus: { type: "loading" } }
            : {
                ...NO_DOCUMENT,
                resourceId: event.payload.resourceId,
                recordingStatus: { type: "loading" },
              },
      };
    case "recordingRead":
      return state.document.resourceId === event.payload.resourceId
        ? {
            ...state,
            document: {
              ...state.document,
              recording: event.payload.envelope,
              recordingStatus: { type: "ready" },
            },
          }
        : state;
    case "recordingFailed":
      return state.document.resourceId === event.payload.resourceId
        ? {
            ...state,
            document: {
              ...state.document,
              recordingStatus: { type: "failed", payload: { reason: event.payload.reason } },
            },
          }
        : state;
    case "recommended":
      return {
        ...state,
        recommended: event.payload.resourceIds,
        profile: event.payload.profile,
      };
    // Opening and editing both clear the composed post: it names the previous
    // answer, and leaving it would let the player send a version they have
    // already changed away from.
    case "reviewOpened":
    case "reviewChanged":
      return { ...state, review: event.payload.draft, reviewPost: null };
    case "reviewComposed":
      return { ...state, reviewPost: event.payload.post };
    case "reviewClosed":
      return { ...state, review: null, reviewPost: null };
    case "contributionOpened":
    case "contributionChanged":
      return { ...state, contribution: event.payload.draft, contributionPost: null };
    case "contributionComposed":
      return { ...state, contributionPost: event.payload.post };
    case "contributionClosed":
      return { ...state, contribution: null, contributionPost: null };
    case "lessonRecordsLoaded":
      return { ...state, lessonRecords: event.payload.records };
    case "lessonPreparing":
      return { ...state, lessonLaunch: { type: "preparing", payload: event.payload } };
    case "lessonPlaying":
      return { ...state, lessonLaunch: { type: "playing", payload: event.payload } };
    case "lessonLaunchFailed":
      return { ...state, lessonLaunch: { type: "failed", payload: event.payload } };
    case "lessonLaunchCancelled":
      return { ...state, lessonLaunch: { type: "idle" } };
    case "lessonFinished": {
      const { resourceId, score } = event.payload;
      const lessonLaunch = { type: "finished" as const, payload: { resourceId, score } };
      // A run quit before its debrief wrote nothing, and changes no record.
      if (!score) return { ...state, lessonLaunch };
      return {
        ...state,
        lessonLaunch,
        lessonRecords: {
          ...state.lessonRecords,
          [resourceId]: recordRun(state.lessonRecords[resourceId], score),
        },
      };
    }
  }
}
