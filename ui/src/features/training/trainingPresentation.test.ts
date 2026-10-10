import { describe, expect, it } from "vitest";

import type { TrainingResource } from "../../ipc/bindings";
import { entryForLink } from "./trainingPresentation";

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
