// Conformance in orders nobody planned: the frontend reducer must agree with
// the Rust one on the scenario cases' events interleaved, shuffled, dropped,
// repeated, and replayed from each other's intermediate states.
//
// `reducer.conformance.test.ts` replays every event variant along the path its
// case was written for. That is breadth. This fixture is the depth: a stale
// answer after a newer request, a completion without its start, the same
// event twice. It is written by
// `crates/faf-domain/tests/conformance_fixtures/orderings.rs` on every
// `cargo test`, from a fixed seed, so a failure here reproduces.
//
// Each step names an event and how the slice changed (`unset`, then `set`, as
// paths into the slice), both by index into deduplicated tables, rather than
// storing the slice itself; storing every step whole would be tens of MB. The
// expectation is rebuilt from those diffs and then compared
// whole, and every other slice must be left exactly as it started, so the
// full `AppState` is checked after every step.
//
// If this fails after a Rust change, the twin has not kept up. Fix the twin,
// not the fixture.

import { describe, expect, it } from "vitest";
import type { AppEvent, AppState } from "../ipc/bindings";
import scenarios from "./__fixtures__/reducer-conformance.json";
import fixture from "./__fixtures__/reducer-conformance-orderings.json";
import { applyEvent } from "./reducer";

type Path = Array<string | number>;

interface Diff {
  set?: Array<[Path, unknown]>;
  unset?: Path[];
}

interface Sequence {
  name: string;
  slice: keyof AppState;
  start: number;
  /** `[event, diff]` indices into the fixture's tables. */
  steps: Array<[number, number]>;
}

interface OrderingFixture {
  seed: string;
  events: AppEvent[];
  diffs: Diff[];
  starts: unknown[];
  sequences: Sequence[];
}

const orderings = fixture as unknown as OrderingFixture;
const initial = scenarios.initial as unknown as AppState;

/** Copy-on-write write at `path`; an empty path replaces the value. */
function setIn(target: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) {
    return value;
  }
  const [head, ...rest] = path;
  if (typeof head === "number") {
    const copy = [...(target as unknown[])];
    copy[head] = setIn(copy[head], rest, value);
    return copy;
  }
  const object = target as Record<string, unknown>;
  return { ...object, [head]: setIn(object[head], rest, value) };
}

/** Copy-on-write removal of the object key at the end of `path`. */
function unsetIn(target: unknown, path: Path): unknown {
  const [head, ...rest] = path;
  if (typeof head === "number") {
    const copy = [...(target as unknown[])];
    copy[head] = unsetIn(copy[head], rest);
    return copy;
  }
  const copy = { ...(target as Record<string, unknown>) };
  if (rest.length === 0) {
    delete copy[head];
  } else {
    copy[head] = unsetIn(copy[head], rest);
  }
  return copy;
}

function rebuild(previous: unknown, diff: Diff): unknown {
  let next = previous;
  for (const path of diff.unset ?? []) {
    next = unsetIn(next, path);
  }
  for (const [path, value] of diff.set ?? []) {
    next = setIn(next, path, value);
  }
  return next;
}

describe("the frontend reducer matches the Rust one in generated orders", () => {
  it("has sequences to run", () => {
    // Guards against an empty or half-written fixture quietly passing.
    expect(orderings.sequences.length).toBeGreaterThan(0);
    expect(orderings.sequences.every((sequence) => sequence.steps.length > 0)).toBe(true);
  });

  it.each(orderings.sequences.map((sequence, index) => [`#${index} ${sequence.name}`, sequence] as const))(
    "%s",
    (_name, sequence) => {
      const { slice } = sequence;
      // Every other slice is Rust's default, as the cases that produced the
      // starting states left them.
      const start: AppState = { ...initial, [slice]: orderings.starts[sequence.start] };
      let state = start;
      let expected: unknown = start[slice];
      sequence.steps.forEach(([eventIndex, diffIndex], index) => {
        const event = orderings.events[eventIndex];
        state = applyEvent(state, event);
        expected = rebuild(expected, orderings.diffs[diffIndex]);
        const context = `${orderings.seed}, after step ${index + 1}: ${JSON.stringify(event)}`;
        expect(state[slice], context).toEqual(expected);
        for (const other of Object.keys(start) as Array<keyof AppState>) {
          // Identity first: the reducer never rebuilds a slice it does not
          // own, so the deep comparison only runs to explain a failure.
          if (other !== slice && state[other] !== start[other]) {
            expect(state[other], `${context}; unexpected change in ${other}`).toEqual(start[other]);
          }
        }
      });
    },
  );
});
