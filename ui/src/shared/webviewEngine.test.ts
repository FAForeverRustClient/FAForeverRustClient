import { describe, expect, it } from "vitest";

import { assessWebview, probeCss, REQUIRED_CSS } from "./webviewEngine";

const modern = () => true;
const ancient = () => false;

describe("assessWebview", () => {
  it("stays silent when the engine supports everything the stylesheets use", () => {
    const assessment = assessWebview({ platform: "linux", webkitVersion: "2.48.0" }, modern);
    expect(assessment.missing).toEqual([]);
    expect(assessment.version).toBe("2.48.0");
  });

  it("names every unsupported feature, because the user has to recognise the symptom", () => {
    const assessment = assessWebview({ platform: "linux", webkitVersion: "2.36.8" }, ancient);
    expect(assessment.missing).toEqual(REQUIRED_CSS.map((requirement) => requirement.label));
  });

  it("reports one missing feature without dragging the working ones in", () => {
    const assessment = assessWebview(
      { platform: "linux", webkitVersion: "2.38.0" },
      (requirement) => requirement.label !== "color-mix()",
    );
    expect(assessment.missing).toEqual(["color-mix()"]);
  });

  it("carries a null version through, since Windows and macOS have none to report", () => {
    expect(assessWebview({ platform: "windows", webkitVersion: null }, modern).version).toBeNull();
  });
});

describe("probeCss", () => {
  // The suite runs in Node, which has no `CSS` at all, and a browser preview
  // has an engine whose answers we do not control. Warning on an environment
  // that cannot answer would be a false alarm, so ignorance reads as support.
  it("treats an environment that cannot answer as supporting the feature", () => {
    for (const requirement of REQUIRED_CSS) {
      expect(probeCss(requirement)).toBe(true);
    }
  });
});
