import { describe, expect, it } from "vitest";
import { changelogUnitIconBackground, changelogUnitIconId, changelogUnitIconUrl } from "./changelogUnitIcons";

const legacy = "https://raw.githubusercontent.com/FAForever/patchnotes/0d01e845da4d72173492751d153771ee17a0f079/images/";
const clean = "https://faforever.github.io/fa/assets/icons/";

describe("legacy changelog unit pictures", () => {
  it.each([
    ["UEB4301", "land"],
    ["UEB0102", "air"],
    ["UEB0103", "sea"],
    ["UES0304", "sea"],
    ["URL0401", "amph"],
    ["UAL0001", "amph"],
    ["UEL0203", "amph"],
  ])("uses the blueprint's background for %s", (id, background) => {
    expect(changelogUnitIconBackground(clean + id + "_icon.png")).toBe(background);
  });

  it("keeps the background tied to the original portrait", () => {
    expect(changelogUnitIconBackground(legacy + "nukesub.png")).toBe("sea");
    expect(changelogUnitIconBackground(clean + "ZZZ9999_icon.png")).toBeNull();
    expect(changelogUnitIconBackground(legacy + "Enhancements/uef/teleport.png")).toBeNull();
  });

  it("identifies local artwork from the picture rather than its caption", () => {
    expect(changelogUnitIconId(legacy + "nukesub.png")).toBe("UES0304");
    expect(changelogUnitIconId(clean + "UEL0303_icon.png")).toBe("UEL0303");
  });

  // Every unit with a recorded background must be reachable from its icon, or
  // the record is dead weight and the unit falls back to web artwork.
  it.each(["DALK003", "DELK002", "DRLK001", "DSLK004"])("identifies the T3 mobile anti-air unit %s", (id) => {
    expect(changelogUnitIconId(clean + id + "_icon.png")).toBe(id);
    expect(changelogUnitIconBackground(clean + id + "_icon.png")).toBe("land");
  });

  it.each([
    legacy + "unknown.png",
    legacy + "Enhancements/uef/teleport.png",
    clean + "UEL0303_icon.png?other=true",
    clean + "../icons/UEL0303_icon.png",
    clean + "UEL0303_icon.png/extra",
    clean.replace("faforever.github.io", "example.invalid") + "UEL0303_icon.png",
    "/assets/changelog/categories/land.png",
  ])("does not infer a local unit from unrelated artwork %s", (source) => {
    expect(changelogUnitIconId(source)).toBeNull();
  });

  it.each([
    ["nukesub.png", "UES0304"],
    ["UEF_T2_Shield_Boat.png", "XES0205"],
    ["cybranT2StaticArty.png", "URB2303"],
    ["seraT3StaticArty.png", "XSB2302"],
    ["renegade.png", "URA0203"],
    ["restorer.png", "XAA0305"],
    ["hiveT1.png", "XRB0104"],
    ["hiveT2.png", "XRB0204"],
    ["hiveT3.png", "XRB0304"],
  ])("uses the clean original for %s", (file, unitId) => {
    expect(changelogUnitIconUrl(legacy + file)).toBe(`${clean}${unitId}_icon.png`);
  });

  it.each([
    legacy + "torrent.png",
    legacy + "Enhancements/uef/teleport.png",
    legacy + "unknown.png",
    legacy + "constructor",
    legacy + "nukesub.png?original=true",
    legacy + "../images/nukesub.png",
    legacy.replace("0d01e845da4d72173492751d153771ee17a0f079", "other-revision") + "nukesub.png",
    "https://example.invalid/images/nukesub.png",
    clean + "UES0304_icon.png",
    "/assets/changelog/categories/sea.png",
  ])("preserves unmatched or already clean source %s", (source) => {
    expect(changelogUnitIconUrl(source)).toBe(source);
  });
});
