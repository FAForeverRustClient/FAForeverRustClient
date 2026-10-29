import { describe, expect, it } from "vitest";
import type { ChangelogBlock } from "../ipc/bindings";
import { historicalChangelogIllustrations } from "./historicalChangelogIcons";

const heading = (text: string, level = 2): ChangelogBlock => ({ type: "heading", payload: { level, text } });
const paragraph = (text: string): ChangelogBlock => ({ type: "paragraph", payload: { spans: [{ type: "text", payload: text }] } });

describe("historical patchnote illustrations", () => {
  it("distinguishes faction commanders from broad tier groups without changing the source", () => {
    const blocks = [heading("ACUs"), heading("Cybran", 3), heading("T2 units"), heading("Aeon t2", 3), heading("UEF t2", 3)];
    const original = structuredClone(blocks);
    const icons = historicalChangelogIllustrations("3626", blocks);
    expect(icons.get(0)?.icons).toHaveLength(4);
    expect(icons.get(1)?.icons).toEqual([{ type: "unit", unitId: "URL0001", iconUrl: "https://faforever.github.io/fa/assets/icons/URL0001_icon.png" }]);
    expect(icons.has(2)).toBe(false);
    expect(icons.get(3)?.icons).toEqual([{ type: "faction", faction: 2 }]);
    expect(icons.get(4)?.icons).toEqual([{ type: "faction", faction: 1 }]);
    expect(blocks).toEqual(original);
  });

  it("uses the original named unit identities, including historical spelling", () => {
    const icons = historicalChangelogIllustrations("3619", [heading("Soul Reaper"), heading("Novax"), heading("T3 SubHunter"), heading("Torrent Missile Ship")]);
    expect([...icons.values()].flatMap(value => value.icons).map(icon => icon.type === "unit" && icon.unitId)).toEqual([
      "URA0401", "XEB2402", "XSS0304", "XAS0306",
    ]);
  });

  it("keeps a faction paragraph beside the preceding faction headings instead of beneath them", () => {
    const blocks = [heading("ACUs"), heading("Cybran", 3), heading("Seraphim", 3), heading("Aeon", 3), paragraph("UEF"), heading("T1 units")];
    const original = structuredClone(blocks);
    const icons = historicalChangelogIllustrations("3626", blocks);
    expect(icons.get(4)?.headingLevel).toBe(3);
    expect(icons.get(4)?.icons[0]).toMatchObject({ type: "unit", unitId: "UEL0001" });
    expect(icons.has(5)).toBe(false);
    expect(blocks).toEqual(original);
  });

  it("gives mixed-markup faction labels the same level in the historical XP group", () => {
    const icons = historicalChangelogIllustrations("3615", [heading("Balance changes"), heading("XP changes", 3),
      paragraph("UEF"), paragraph("Satellite Station :"), paragraph("Cybran"), paragraph("- Soul Ripper :"), paragraph("Seraphim"), paragraph("Aeon")]);
    expect([2, 4, 6, 7].map(index => icons.get(index)?.headingLevel)).toEqual([4, 4, 4, 4]);
    expect(icons.get(3)?.headingLevel).toBeUndefined();
    expect(icons.get(5)?.headingLevel).toBeUndefined();
  });

  it("treats contributor names as credit prose only inside an explicit credits section", () => {
    const names = "Pip, Blackheart, Crazed, Lu_Xun_17, Nombringer, TAG_Chosen, Voodoo, Zock";
    const blocks = [heading("Balance Team credits :"), heading(names), heading("Bug fixes"), heading("Aeon, Cybran")];
    const original = structuredClone(blocks);
    const icons = historicalChangelogIllustrations("3626", blocks);
    expect(icons.get(1)).toEqual({ text: names, icons: [], asParagraph: true });
    expect(icons.has(0)).toBe(false);
    expect(icons.has(3)).toBe(false);
    expect(blocks).toEqual(original);
  });

  it("keeps successive experimental unit captions beside the general veterancy subsection", () => {
    const icons = historicalChangelogIllustrations("3626", [heading("T4 units"), heading("General change : Veterancy levels adjustments.", 3),
      paragraph("Atlantis"), paragraph("Monkeylord"), heading("Balance Team credits :")]);
    expect(icons.get(2)?.icons[0]).toMatchObject({ type: "unit", unitId: "UES0401" });
    expect(icons.get(3)?.icons[0]).toMatchObject({ type: "unit", unitId: "URL0402" });
    expect([2, 3].map(index => icons.get(index)?.headingLevel)).toEqual([3, 3]);
    expect(icons.has(4)).toBe(false);
  });

  it("illustrates short original unit captions, including their existing punctuation", () => {
    const icons = historicalChangelogIllustrations("3615", [paragraph("- UEF BattleCruiser :"), paragraph("- Ythota Veterancy :"), paragraph("Tempest should now be more effective in naval battle.")]);
    expect(icons.get(0)?.text).toBe("- UEF BattleCruiser :");
    expect(icons.get(0)?.icons[0]).toMatchObject({ type: "unit", unitId: "XES0307" });
    expect(icons.get(1)?.icons[0]).toMatchObject({ type: "unit", unitId: "XSL0401" });
    expect(icons.has(2)).toBe(false);
  });

  it("requires the SCU faction context for shared upgrade names and clears it at the next section", () => {
    const blocks = [heading("SCU rebalance"), heading("Aeon SCU", 3), paragraph("Shield:"), paragraph("Ressource Allocation System:"),
      heading("Cybran SCU", 3), paragraph("Personal Cloak:"), heading("Seraphim SCU", 3), paragraph("Missile:"), heading("Bug fixes"), paragraph("Shield:")];
    const icons = historicalChangelogIllustrations("3619", blocks);
    expect(icons.get(1)?.icons[0]).toMatchObject({ type: "unit", unitId: "UAL0301" });
    for (const [index, suffix] of [[2, "/aeon/shield.png"], [3, "/aeon/ras.png"], [5, "/cybran/cloack.png"], [7, "/sera/scu%20tml.png"]] as const) {
      const icon = icons.get(index)?.icons[0];
      if (icon?.type !== "unit") throw new Error("expected the verified upgrade picture");
      expect(icon.iconUrl).toContain(suffix);
    }
    expect(icons.has(9)).toBe(false);
  });

  it("requires the original stationary-artillery group for faction-only artillery captions", () => {
    const icons = historicalChangelogIllustrations("3621", [heading("Cybran Arty"), heading("T3 stationnary arty"), heading("Cybran Arty", 4)]);
    expect(icons.has(0)).toBe(false);
    expect(icons.get(2)?.icons[0]).toMatchObject({ type: "unit", unitId: "URB2302" });
  });

  it("keeps different historical repair upgrade names tied to their actual SCU faction", () => {
    const icons = historicalChangelogIllustrations("3619", [heading("Aeon SCU"), paragraph("SystemIntegrityCompensator (Nano Repair Equivalent):"),
      heading("Cybran SCU"), paragraph("SelfRepairSystem:")]);
    const aeon = icons.get(1)?.icons[0];
    const cybran = icons.get(3)?.icons[0];
    expect(aeon?.type === "unit" && aeon.iconUrl.endsWith("/aeon/nano.png")).toBe(true);
    expect(cybran?.type === "unit" && cybran.iconUrl.endsWith("/cybran/nano.png")).toBe(true);
  });

  it("leaves broad changes, credits, unknown captions and nonhistorical notes alone", () => {
    const blocks = [heading("Graphics enhancements"), heading("Economy"), heading("General change: Veterancy adjustments."), heading("Balance Team credits :"),
      paragraph("Pip, Blackheart, Crazed, Lu_Xun_17, Nombringer, TAG_Chosen, Voodoo, Zock"), heading("Some unverified unit"), heading("Aeon damage changed"), heading("constructor")];
    expect(historicalChangelogIllustrations("3626", blocks).size).toBe(0);
    expect(historicalChangelogIllustrations("3818", [heading("Aeon T2"), heading("Tempest")]).size).toBe(0);
    expect(historicalChangelogIllustrations("v0.9.2", [heading("Tempest")]).size).toBe(0);
  });
});
