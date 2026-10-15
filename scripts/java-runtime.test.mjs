import { expect, test } from "vitest";
import { checkJavaRuntime, JAVA_RUNTIMES } from "./java-runtime.mjs";

test("every release platform has a pinned Java archive", () => {
  for (const platform of ["linux/x64", "win32/x64"]) {
    expect(JAVA_RUNTIMES[platform].sha256).toMatch(/^[a-f0-9]{64}$/);
  }
});

test("the release check refuses absent, broken and obsolete runtimes", () => {
  expect(() => checkJavaRuntime("java", { exists: () => false })).toThrow(/missing/);
  for (const result of [
    { status: 1, stderr: "" },
    { status: 0, stderr: 'openjdk version "21.0.8"' },
    { status: 0, stderr: "not Java" },
  ]) {
    expect(() => checkJavaRuntime("java", { exists: () => true, run: () => result })).toThrow();
  }
  expect(checkJavaRuntime("java", {
    exists: () => true,
    run: () => ({ status: 0, stderr: 'openjdk version "25.0.3"' }),
  })).toBe(25);
});
