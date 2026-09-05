import type { TrainingQuery } from "../ipc/bindings";

/** Mirrors `TrainingQuery::default`: the unfiltered library. */
export const EMPTY_TRAINING_QUERY: TrainingQuery = {
  text: "",
  level: null,
  kind: null,
  topic: null,
  gameMode: "",
  map: "",
  myRatingOnly: false,
};

/** Whether a query narrows anything, which is what decides if "clear" is offered. */
export function trainingQueryIsEmpty(query: TrainingQuery): boolean {
  return (
    query.text.trim() === "" &&
    query.level === null &&
    query.kind === null &&
    query.topic === null &&
    query.gameMode === "" &&
    query.map.trim() === "" &&
    !query.myRatingOnly
  );
}
