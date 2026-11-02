import type { TrainingQuery } from "../ipc/bindings";
import { INITIAL_STATE } from "../ipc/initialState";

/**
 * The unfiltered library: `TrainingQuery::default()`, read from the generated
 * initial state (the slice's `query` starts there) rather than written out.
 */
export const EMPTY_TRAINING_QUERY: TrainingQuery = INITIAL_STATE.training.query;

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
