import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

const defaultInput = "ui/src/store/__fixtures__/reducer-conformance.json";
const input = resolve(process.argv[2] ?? defaultInput);
const document = JSON.parse(readFileSync(input, "utf8"));

function samplesFrom(value) {
  if (value?.initial && Array.isArray(value?.cases)) {
    return {
      label: "reducer conformance fixture",
      states: [value.initial, ...value.cases.flatMap((testCase) =>
        testCase.steps.map((step) => step.expected))],
      events: value.cases.flatMap((testCase) => testCase.steps.map((step) => step.event)),
    };
  }
  if (value?.state) {
    return { label: "captured versioned snapshot", states: [value.state], events: [] };
  }
  return { label: "captured application state", states: [value], events: [] };
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(2)} MiB`;
}

function millisecondsPerRun(work, runs) {
  const started = performance.now();
  for (let index = 0; index < runs; index += 1) work();
  return (performance.now() - started) / runs;
}

const samples = samplesFrom(document);
const serializedStates = samples.states.map((state) => JSON.stringify(state));
const stateSizes = serializedStates.map((state) => Buffer.byteLength(state, "utf8")).sort((left, right) => left - right);
const eventSizes = samples.events.map(bytes).sort((left, right) => left - right);
const largestState = serializedStates.reduce((largest, state) =>
  Buffer.byteLength(state, "utf8") > Buffer.byteLength(largest, "utf8") ? state : largest,
);
const benchmarkRuns = Math.max(25, Math.min(500, Math.floor(50_000_000 / largestState.length)));
const parsed = JSON.parse(largestState);
const parseMs = millisecondsPerRun(() => JSON.parse(largestState), benchmarkRuns);
const stringifyMs = millisecondsPerRun(() => JSON.stringify(parsed), benchmarkRuns);
const stateP95 = percentile(stateSizes, 0.95);

console.log(`State-sync measurement: ${samples.label}`);
console.log(`Input: ${input}`);
console.log(`Samples: ${stateSizes.length} states, ${eventSizes.length} events`);
console.log(`Snapshot JSON: p50 ${formatBytes(percentile(stateSizes, 0.5))}, p95 ${formatBytes(stateP95)}, max ${formatBytes(stateSizes.at(-1))}`);
if (eventSizes.length > 0) {
  console.log(`Event JSON:    p50 ${formatBytes(percentile(eventSizes, 0.5))}, p95 ${formatBytes(percentile(eventSizes, 0.95))}, max ${formatBytes(eventSizes.at(-1))}`);
}
console.log(`Largest-snapshot JSON.parse: ${parseMs.toFixed(3)} ms/op (${benchmarkRuns} runs)`);
console.log(`Largest-snapshot stringify:  ${stringifyMs.toFixed(3)} ms/op (${benchmarkRuns} runs)`);
console.log(`Snapshot bandwidth at 10 events/s (p95): ${formatBytes(stateP95 * 10)}/s`);

if (samples.label === "reducer conformance fixture") {
  console.log("Caveat: this fixture exercises reducer shapes, not a populated live session. Capture a real versioned snapshot before changing the IPC architecture.");
}
