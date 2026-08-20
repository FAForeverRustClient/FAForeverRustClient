// Is the system webview new enough for the interface we ship?
//
// Windows and macOS move their webview forward with the operating system, so
// the question only has a real answer on Linux: a GTK build renders in whatever
// WebKitGTK the distribution packages, and an old-stable release can predate
// the CSS this client is written in by years. That is not hypothetical. The
// vault, map, replay and modal stylesheets alone contain roughly forty
// `color-mix()` declarations, and an engine that cannot parse the function
// discards those declarations outright rather than approximating them, which
// takes the colour with it.
//
// The gate is capability probing, not the version number. A version-to-feature
// table would have to be maintained against every WebKitGTK release and would
// be wrong for exactly the distribution builds we are trying to catch, whereas
// `CSS.supports` asks the engine that is actually running. The version is
// reported alongside, because it is the first thing a bug report needs and the
// only thing that tells the user what to update.

import { native, type WebviewEngine } from "../ipc/native";

/**
 * Guidance for the banner copy only, never a gate.
 *
 * WebKitGTK 2.40 (spring 2023) is the first release that covers everything
 * probed below. Being slightly off here costs a mildly inaccurate sentence,
 * not a false warning.
 */
export const RECOMMENDED_WEBKITGTK = "2.40";

/** A single `CSS.supports` question, in the syntax the engine is asked. */
export interface CssRequirement {
  /** Shown verbatim in the warning: CSS syntax is the same in every language. */
  readonly label: string;
  readonly property: string;
  readonly value: string;
}

/**
 * The features whose absence visibly breaks this client.
 *
 * Deliberately short. `backdrop-filter` is not here even though the modal and
 * vault stylesheets use it: without it a panel is merely opaque instead of
 * blurred, and WebKitGTK routinely reports it as unsupported when compositing
 * is disabled, which would put a warning in front of users whose client is
 * completely fine.
 */
export const REQUIRED_CSS: readonly CssRequirement[] = [
  // Roughly forty declarations across the feature stylesheets.
  { label: "color-mix()", property: "color", value: "color-mix(in srgb, white 50%, black)" },
  // Selector support is asked for as a selector, not as a declaration.
  { label: ":has()", property: "selector(:has(*))", value: "" },
  { label: "aspect-ratio", property: "aspect-ratio", value: "1 / 1" },
];

export interface WebviewAssessment {
  /** `major.minor.micro`, or null where the platform has no version to report. */
  readonly version: string | null;
  /** Labels of the probed features this engine does not support. */
  readonly missing: readonly string[];
}

/**
 * True inside the Tauri shell, false in a plain browser or a test.
 *
 * The `typeof` guard is for the Node test environment, which has no `window`
 * at all: a bare `in` check there throws rather than answering "no".
 */
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Ask the engine directly.
 *
 * An environment without `CSS.supports` (the Node test runner, a very old
 * browser) reports everything as supported: warning from ignorance is worse
 * than staying quiet, and the desktop shell always has the API.
 */
export function probeCss(requirement: CssRequirement): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return true;
  try {
    return requirement.value === ""
      ? CSS.supports(requirement.property)
      : CSS.supports(requirement.property, requirement.value);
  } catch {
    // A parser that throws on `selector(...)` is itself the answer, but an
    // exception is not proof of which feature is missing, so it is not counted.
    return true;
  }
}

/**
 * Pure policy, so the decision is testable without a webview.
 *
 * `supports` is injected rather than called directly for the same reason.
 */
export function assessWebview(
  engine: WebviewEngine,
  supports: (requirement: CssRequirement) => boolean = probeCss,
): WebviewAssessment {
  return {
    version: engine.webkitVersion,
    missing: REQUIRED_CSS.filter((requirement) => !supports(requirement)).map(
      (requirement) => requirement.label,
    ),
  };
}

/**
 * Assess the running engine, or return null when there is nothing to say.
 *
 * Null covers three cases that all mean "do not warn": running outside the
 * desktop shell, a shell that refuses the command, and an engine that supports
 * everything asked of it.
 */
export async function assessRunningWebview(): Promise<WebviewAssessment | null> {
  if (!isDesktopShell()) return null;
  let engine: WebviewEngine;
  try {
    engine = await native.webviewEngine();
  } catch {
    // An older shell without the command is not a broken engine.
    return null;
  }
  const assessment = assessWebview(engine);
  return assessment.missing.length > 0 ? assessment : null;
}
