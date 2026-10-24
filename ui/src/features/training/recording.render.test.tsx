import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BuildFlow } from "./BuildFlow";
import { RunMap } from "./RunMap";
import { parseEnvelope, runStalls, toLanes } from "./recording";

function document(map?: unknown, category = "engie") {
  return JSON.stringify({
    schema: "faf-bo/1",
    meta: { name: "run", durationMs: 60_000, map },
    bo: {
      name: "ACU", category: "acu", entityId: "0", startTime: 0, finishTime: null,
      x: 0, z: 0, builds: [{
        name: "Engineer", category, entityId: "1", startTime: 0, finishTime: 10_000,
        x: 0, z: 0, builds: [],
      }],
    },
    markers: [],
    paths: [{
      id: "1", name: "Engineer", cat: category, ordinal: 1, birth: 0,
      points: [{ t: 0, x: 0, z: 0 }, { t: 1000, x: 1, z: 1 }],
    }],
  });
}

describe("drawing accepted recording documents", () => {
  it("draws a legacy flow and the missing-map message without optional metadata", () => {
    const env = parseEnvelope(document())!;
    expect(env).not.toBeNull();
    const flow = renderToStaticMarkup(<BuildFlow
      lanes={toLanes(env.bo)} durationMs={env.meta.durationMs}
      stalls={runStalls(env)} hovered={null} onHover={() => undefined}
    />);
    expect(flow).toContain("Engineer");
    const map = renderToStaticMarkup(<RunMap
      env={env} previewUrl="" hovered={null} onHover={() => undefined}
    />);
    expect(map).toContain("training-run-problem");
    expect(map).not.toContain("<svg");
  });

  it("draws unfamiliar categories safely, including prototype property names", () => {
    const env = parseEnvelope(document({ sizeX: 256, sizeZ: 256 }, "constructor"))!;
    const markup = renderToStaticMarkup(<RunMap
      env={env} previewUrl="" hovered={null} onHover={() => undefined}
    />);
    expect(markup).toContain("constructor");
    expect(markup).toContain("<svg");
    expect(markup).not.toMatch(/NaN|Infinity/);
  });
});
