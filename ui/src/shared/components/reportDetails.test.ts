import { describe, expect, it } from "vitest";
import { reportDetailsText } from "./ReportDialog";

describe("reportDetailsText", () => {
  it("names the thing first, then what identifies it", () => {
    // What gets pasted into Discord. Plain `label: value` lines, because a
    // formatted table arrives there as a wall of pipes.
    expect(
      reportDetailsText("Mod", "Total Mayhem", [
        { label: "Author", value: "Burnie" },
        { label: "Version", value: "v137" },
        { label: "UID", value: "abc-123" },
      ]),
    ).toBe("Mod: Total Mayhem\nAuthor: Burnie\nVersion: v137\nUID: abc-123");
  });

  it("leaves out what the vault does not know", () => {
    // A map with no uploader on record would otherwise paste "Author: " and
    // invite the moderator to wonder whose fault that is.
    expect(
      reportDetailsText("Map", "Setons Clutch", [
        { label: "Author", value: "" },
        { label: "Author", value: "   " },
        { label: "Folder", value: "scmp_009" },
      ]),
    ).toBe("Map: Setons Clutch\nFolder: scmp_009");
  });

  it("still says which item it is when nothing else is known", () => {
    expect(reportDetailsText("Map", "scmp_009", [])).toBe("Map: scmp_009");
  });
});
