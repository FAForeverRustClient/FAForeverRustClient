import { describe, expect, it } from "vitest";

import type { TrainingResource } from "../../ipc/bindings";
import {
  entryForLink,
  isCatalogueLesson,
  lessonBusy,
  lessonLaunchFor,
  lessonTime,
} from "./trainingPresentation";

const guide = (id: string, url: string): TrainingResource => ({
  id,
  title: id,
  summary: "",
  kind: "guide",
  level: null,
  imageUrl: "",
  url,
  recordingUrl: "",
  readable: true,
  tutorialId: null,
  lesson: null,
  author: "",
  ratingMin: null,
  ratingMax: null,
  gameModes: [],
  topics: [],
  maps: [],
  factions: [],
  durationMinutes: null,
  related: [],
  approvedBy: "",
  updatedAt: "",
});

describe("entryForLink", () => {
  const raw = "https://raw.githubusercontent.com/FAForeverRustClient/guides/main/guides/forum-ui-mods.md";
  const resources = [guide("other", "https://www.youtube.com/watch?v=aaaaaaaaaaa"), guide("ui-mods", raw)];

  it("finds a guide by the address it is read from", () => {
    expect(entryForLink(resources, raw)?.id).toBe("ui-mods");
  });

  it("finds it by the page GitHub renders it as, which is what guides link to", () => {
    const page = "https://github.com/FAForeverRustClient/guides/blob/main/guides/forum-ui-mods.md#ecomanager";
    expect(entryForLink(resources, page)?.id).toBe("ui-mods");
  });

  it("finds nothing for a page the catalogue does not hold", () => {
    expect(entryForLink(resources, "https://forum.faforever.com/topic/1186/ui-mods")).toBeNull();
  });
});

describe("catalogue lessons", () => {
  const lesson: TrainingResource = {
    ...guide("lesson-gunships", ""),
    kind: "lesson",
    lesson: { folder: "FAF_Lesson_A", files: ["FAF_Lesson_A_scenario.lua"] },
  };

  it("counts only a lesson-kind entry carrying a package", () => {
    expect(isCatalogueLesson(lesson)).toBe(true);
    expect(isCatalogueLesson({ ...lesson, lesson: null })).toBe(false);
    expect(isCatalogueLesson({ ...lesson, kind: "guide" })).toBe(false);
  });

  it("draws a launch state only on the lesson it names", () => {
    const preparing = {
      type: "preparing" as const,
      payload: { resourceId: "lesson-gunships", detail: "Updating the game" },
    };
    expect(lessonLaunchFor(preparing, "lesson-gunships")).toBe(preparing);
    expect(lessonLaunchFor(preparing, "lesson-reclaim")).toBeNull();
    expect(lessonLaunchFor({ type: "idle" }, "lesson-gunships")).toBeNull();
  });

  it("holds every start button while any lesson is in flight", () => {
    expect(lessonBusy({ type: "playing", payload: { resourceId: "x" } })).toBe(true);
    expect(lessonBusy({ type: "failed", payload: { resourceId: "x", reason: "no" } })).toBe(false);
    expect(lessonBusy({ type: "idle" })).toBe(false);
  });

  it("reads a run's length the way a game clock does", () => {
    expect(lessonTime(431)).toBe("7:11");
    expect(lessonTime(59)).toBe("0:59");
    expect(lessonTime(600)).toBe("10:00");
    expect(lessonTime(-3)).toBe("0:00");
  });
});
