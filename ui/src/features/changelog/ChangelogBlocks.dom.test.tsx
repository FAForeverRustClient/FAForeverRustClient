// @vitest-environment happy-dom

import { createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ChangelogBlock } from "../../ipc/bindings";
import { anchorFor, noteSections, NoteBlocks, NoteContentsColumn } from "./noteReader";
import { historicalChangelogIllustrations } from "../../shared/historicalChangelogIcons";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { clearSentCommands, sentCommands } from "../../testing/mounted";
import { en } from "../../i18n/catalog/en";
import { ChangelogBlockView } from "../../shared/components/ChangelogBlocks";
import { ChangelogIllustration } from "../../shared/components/ChangelogIllustration";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("../../ipc/native", () => ({ native: { openUrl } }));
vi.mock("../../shared/useUnitIcons", () => ({ useUnitIcons: () => ({ units: {}, strategic: {} }) }));
vi.mock("../../ipc/client");
failOnConsoleError();

it("uses the same unmarked naval picture in the article, historical caption and contents", () => {
  const source = "https://raw.githubusercontent.com/FAForever/patchnotes/0d01e845da4d72173492751d153771ee17a0f079/images/nukesub.png";
  const blocks: ChangelogBlock[] = [{ type: "unit", payload: { name: "Nuke Subs", units: [{ unitId: null, iconUrl: source }] } }];
  const sections = noteSections(blocks, false, en["changelog.historicalBalance"]);
  const view = render(<>
    <NoteBlocks blocks={blocks} />
    <NoteContentsColumn sections={sections} activeSectionId={anchorFor(0)} navRef={createRef<HTMLElement>()} onJump={vi.fn()} />
    <ChangelogIllustration illustration={{ type: "unit", iconUrl: source }} className="changelog-unit-icon" size={48} />
  </>);
  const pictures = view.container.querySelectorAll("img");
  expect(pictures).toHaveLength(3);
  for (const picture of pictures) {
    expect(picture.getAttribute("src")).toBe("https://faforever.github.io/fa/assets/icons/UES0304_icon.png");
    expect(picture.getAttribute("alt")).toBe("");
  }
  expect(screen.getByRole("button", { name: "Nuke Subs" })).toBeTruthy();
});

it("shows a replacement historical picture after the previous one failed", () => {
  const first = render(<ChangelogIllustration illustration={{ type: "category", iconUrl: "/assets/changelog/categories/land.png" }}
    className="changelog-unit-icon" size={48} />);
  const image = first.container.querySelector("img")!;
  fireEvent.error(image);
  expect(image.classList.contains("is-missing")).toBe(true);
  first.rerender(<ChangelogIllustration illustration={{ type: "category", iconUrl: "/assets/changelog/categories/air.png" }}
    className="changelog-unit-icon" size={48} />);
  fireEvent.load(first.container.querySelector("img")!);
  expect(first.container.querySelector("img")?.getAttribute("src")).toContain("/air.png");
  expect(first.container.querySelector("img")?.classList.contains("is-missing")).toBe(false);
});

it("restores a contents thumbnail when the reused row loads a valid replacement", () => {
  const section = { id: anchorFor(0), text: "Titan", depth: 2 as const, iconUrl: "https://example.invalid/failed.png" };
  const navRef = createRef<HTMLElement>();
  const first = render(<NoteContentsColumn sections={[section]} activeSectionId={section.id} navRef={navRef} onJump={vi.fn()} />);
  fireEvent.error(first.container.querySelector("img")!);
  first.rerender(<NoteContentsColumn sections={[{ ...section, iconUrl: "https://faforever.github.io/fa/assets/icons/UEL0303_icon.png" }]}
    activeSectionId={section.id} navRef={navRef} onJump={vi.fn()} />);
  const image = first.container.querySelector("img")!;
  fireEvent.load(image);
  expect(image.classList.contains("is-missing")).toBe(false);
});

it("opens a historical illustration securely without changing the source label", async () => {
  const user = userEvent.setup();
  render(<ChangelogBlockView anchorId={anchorFor(0)} block={{ type: "paragraph", payload: { spans: [
    { type: "link", payload: { text: "Original illustration", url: "http://i.imgur.com/vJ17e3e.jpg" } },
  ] } }} />);
  const link = screen.getByRole("button", { name: "Original illustration" });
  expect(link.getAttribute("title")).toBe("https://i.imgur.com/vJ17e3e.jpg");
  await user.click(link);
  expect(openUrl).toHaveBeenCalledWith("https://i.imgur.com/vJ17e3e.jpg");
});

it("uses matching category backgrounds in historical headings and contents without changing their hierarchy", async () => {
  const labels = ["Structures", "Air", "Land", "Sea"];
  const blocks: ChangelogBlock[] = [
    { type: "heading", payload: { level: 2, text: "General" } },
    ...labels.map(text => ({ type: "heading" as const, payload: { level: 3, text } })),
  ];
  const illustrations = historicalChangelogIllustrations("legacy-3605", blocks);
  const sections = noteSections(blocks, false, en["changelog.historicalBalance"], 0, illustrations);
  const onJump = vi.fn();
  render(<>
    <NoteBlocks blocks={blocks} illustrations={illustrations} />
    <NoteContentsColumn sections={sections} activeSectionId={anchorFor(2)} navRef={createRef<HTMLElement>()} onJump={onJump} />
  </>);
  const contents = within(screen.getByRole("navigation", { name: en["changelog.contents"] }));
  expect(screen.getByRole("heading", { name: "General" }).querySelector("img")).toBeNull();
  expect(sections.map(section => section.depth)).toEqual([1, 2, 2, 2, 2]);
  labels.forEach((label, index) => {
    const heading = screen.getByRole("heading", { name: label, level: 3 });
    const bodyIcon = heading.querySelector("img");
    const tocIcon = contents.getByRole("button", { name: label }).querySelector("img");
    expect(bodyIcon?.getAttribute("src")).toBe(`/assets/changelog/categories/${["land", "air", "land", "sea"][index]}.png`);
    expect(tocIcon?.getAttribute("src")).toBe(bodyIcon?.getAttribute("src"));
    expect(bodyIcon?.getAttribute("title")).toBeNull();
    expect(bodyIcon?.getAttribute("alt")).toBe("");
    expect(bodyIcon?.classList.contains("changelog-unit-icon")).toBe(true);
    expect(tocIcon?.classList.contains("changelog-toc-icon")).toBe(true);
    expect(heading.id).toBe(anchorFor(index + 1));
  });
  await userEvent.setup().click(contents.getByRole("button", { name: "Sea" }));
  expect(onJump).toHaveBeenCalledWith(anchorFor(4));
});

it("uses the same historical commander and faction icons in original headings and contents links", async () => {
  const blocks: ChangelogBlock[] = [
    { type: "heading", payload: { level: 2, text: "ACUs" } },
    { type: "heading", payload: { level: 3, text: "Cybran" } },
    { type: "heading", payload: { level: 2, text: "T2 units" } },
    { type: "heading", payload: { level: 3, text: "Aeon t2" } },
  ];
  const illustrations = historicalChangelogIllustrations("3626", blocks);
  const sections = noteSections(blocks, false, en["changelog.historicalBalance"], 0, illustrations);
  const onJump = vi.fn();
  render(<>
    <NoteBlocks blocks={blocks} illustrations={illustrations} />
    <NoteContentsColumn sections={sections} activeSectionId={anchorFor(1)} navRef={createRef<HTMLElement>()} onJump={onJump} />
  </>);
  const contents = within(screen.getByRole("navigation", { name: en["changelog.contents"] }));
  const commander = screen.getByRole("heading", { name: "Cybran", level: 3 });
  expect(commander.querySelector("img")?.getAttribute("src")).toContain("/URL0001_icon.png");
  expect(contents.getByRole("button", { name: "Cybran" }).querySelector("img")?.getAttribute("src")).toBe(commander.querySelector("img")?.getAttribute("src"));
  expect(screen.getByRole("heading", { name: "Aeon t2", level: 3 }).querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(contents.getByRole("button", { name: "Aeon t2" }).querySelector("svg")).not.toBeNull();
  expect(screen.getByRole("heading", { name: "T2 units" }).querySelector("img,svg")).toBeNull();
  expect(sections.map(section => section.depth)).toEqual([1, 2, 1, 2]);
  await userEvent.setup().click(contents.getByRole("button", { name: "Aeon t2" }));
  expect(onJump).toHaveBeenCalledWith(anchorFor(3));
});

it("keeps deep historical unit headings and short upgrade captions reachable without rewriting them", () => {
  const blocks: ChangelogBlock[] = [
    { type: "heading", payload: { level: 2, text: "SCUs" } },
    { type: "heading", payload: { level: 5, text: "Aeon SCU :" } },
    { type: "paragraph", payload: { spans: [{ type: "text", payload: "Ressource Allocation System:" }] } },
  ];
  const illustrations = historicalChangelogIllustrations("3619", blocks);
  const sections = noteSections(blocks, false, en["changelog.historicalBalance"], 0, illustrations);
  render(<NoteBlocks blocks={blocks} illustrations={illustrations} />);
  expect(screen.getByRole("heading", { name: "Aeon SCU :", level: 5 })).toBeTruthy();
  expect(screen.getByText("Ressource Allocation System:").closest("p")?.id).toBe(anchorFor(2));
  expect(sections.map(section => section.text)).toEqual(["SCUs", "Aeon SCU :", "Ressource Allocation System:"]);
  expect(sections.every(section => document.getElementById(section.id))).toBe(true);
  const image = screen.getByText("Ressource Allocation System:").closest("p")?.querySelector("img");
  expect(image?.getAttribute("src")).toContain("/aeon/ras.png");
  if (image) {
    fireEvent.error(image);
    expect(image.classList.contains("is-missing")).toBe(true);
    expect(screen.getByText("Ressource Allocation System:")).toBeTruthy();
  }
});

it("keeps all four 3626 ACU factions as siblings even though UEF was published as a paragraph", async () => {
  const blocks: ChangelogBlock[] = [
    { type: "heading", payload: { level: 2, text: "ACUs" } },
    { type: "heading", payload: { level: 3, text: "Cybran" } },
    { type: "heading", payload: { level: 3, text: "Seraphim" } },
    { type: "heading", payload: { level: 3, text: "Aeon" } },
    { type: "paragraph", payload: { spans: [{ type: "text", payload: "UEF" }] } },
    { type: "heading", payload: { level: 2, text: "T1 units" } },
  ];
  const illustrations = historicalChangelogIllustrations("3626", blocks);
  const sections = noteSections(blocks, false, en["changelog.historicalBalance"], 0, illustrations);
  const onJump = vi.fn();
  render(<>
    <NoteBlocks blocks={blocks} illustrations={illustrations} />
    <NoteContentsColumn sections={sections} activeSectionId={anchorFor(3)} navRef={createRef<HTMLElement>()} onJump={onJump} />
  </>);
  expect(sections.map(section => section.depth)).toEqual([1, 2, 2, 2, 2, 1]);
  const contents = within(screen.getByRole("navigation", { name: en["changelog.contents"] }));
  const group = contents.getByRole("button", { name: "ACUs" });
  expect(group.querySelector("img,svg")).toBeNull();
  const peers = ["Cybran", "Seraphim", "Aeon", "UEF"].map(name => contents.getByRole("button", { name }));
  const parent = peers[0].closest("li")?.parentElement;
  for (const peer of peers) {
    expect(peer.closest("li")?.parentElement).toBe(parent);
    expect(peer.classList.contains("is-group")).toBe(false);
    expect(screen.getByRole("heading", { name: peer.textContent ?? "", level: 3 })).toBeTruthy();
  }
  expect(parent?.parentElement).toBe(group.closest("li"));
  await userEvent.setup().click(peers[3]);
  expect(onJump).toHaveBeenCalledWith(anchorFor(4));
});

it("renders 3626 credits as normal text and keeps experimental units beside the general subsection", () => {
  const general = "General change : Veterancy levels adjustments.";
  const names = "Pip, Blackheart, Crazed, Lu_Xun_17, Nombringer, TAG_Chosen, Voodoo, Zock";
  const blocks: ChangelogBlock[] = [
    { type: "heading", payload: { level: 2, text: "T4 units" } },
    { type: "heading", payload: { level: 3, text: general } },
    { type: "list", payload: { items: [] } },
    { type: "paragraph", payload: { spans: [{ type: "text", payload: "Atlantis" }] } },
    { type: "list", payload: { items: [] } },
    { type: "paragraph", payload: { spans: [{ type: "text", payload: "Monkeylord" }] } },
    { type: "list", payload: { items: [] } },
    { type: "heading", payload: { level: 2, text: "Balance Team credits :" } },
    { type: "heading", payload: { level: 2, text: names } },
  ];
  const illustrations = historicalChangelogIllustrations("3626", blocks);
  const sections = noteSections(blocks, false, en["changelog.historicalBalance"], 0, illustrations);
  render(<>
    <NoteBlocks blocks={blocks} illustrations={illustrations} />
    <NoteContentsColumn sections={sections} activeSectionId={anchorFor(5)} navRef={createRef<HTMLElement>()} onJump={vi.fn()} />
  </>);
  expect(screen.queryByRole("heading", { name: names })).toBeNull();
  const creditText = screen.getByText(names);
  expect(creditText.tagName).toBe("P");
  expect(creditText.classList.contains("changelog-paragraph")).toBe(true);
  expect(screen.getByRole("heading", { name: "Balance Team credits :", level: 2 })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Atlantis", level: 3 }).querySelector("img")?.getAttribute("src")).toContain("/UES0401_icon.png");
  expect(screen.getByRole("heading", { name: "Monkeylord", level: 3 }).querySelector("img")?.getAttribute("src")).toContain("/URL0402_icon.png");
  const contents = within(screen.getByRole("navigation", { name: en["changelog.contents"] }));
  expect(contents.queryByRole("button", { name: names })).toBeNull();
  expect(contents.getByRole("button", { name: "Balance Team credits :" })).toBeTruthy();
  const peers = [general, "Atlantis", "Monkeylord"].map(name => contents.getByRole("button", { name }));
  expect(peers.every(peer => peer.closest("li")?.parentElement === peers[0].closest("li")?.parentElement)).toBe(true);
  expect(sections.map(section => section.depth)).toEqual([1, 2, 2, 2, 1]);
});

it("opens grouped references individually through the existing native URL opener", async () => {
  const user = userEvent.setup();
  render(<ChangelogBlockView anchorId={anchorFor(0)} block={{ type: "paragraph", payload: { spans: [
    { type: "text", payload: "(" },
    { type: "issue", payload: { number: "6481", url: "https://github.com/FAForever/fa/issues/6481" } },
    { type: "text", payload: ", " },
    { type: "issue", payload: { number: "6482", url: "https://github.com/FAForever/fa/issues/6482" } },
    { type: "text", payload: ") Rebalance artillery." },
  ] } }} />);
  expect(screen.getByText(") Rebalance artillery.").parentElement?.textContent).toBe("(#6481, #6482) Rebalance artillery.");
  await user.click(screen.getByRole("button", { name: "#6481" }));
  expect(openUrl).toHaveBeenLastCalledWith("https://github.com/FAForever/fa/issues/6481");
  await user.click(screen.getByRole("button", { name: "#6482" }));
  expect(openUrl).toHaveBeenLastCalledWith("https://github.com/FAForever/fa/issues/6482");
});

it("opens an unmarked numeric citation while preserving its source label", async () => {
  const user = userEvent.setup();
  render(<ChangelogBlockView anchorId={anchorFor(0)} block={{ type: "paragraph", payload: { spans: [
    { type: "text", payload: "Jip (" },
    { type: "issue", payload: { number: "4124", url: "https://github.com/FAForever/fa/issues/4124" } },
    { type: "issue", payload: { number: "4188", url: "https://github.com/FAForever/fa/issues/4188" } },
    { type: "text", payload: ", " },
    { type: "issue", payload: { number: "4230", url: "https://github.com/FAForever/fa/issues/4230", label: "4230" } },
    { type: "text", payload: ")" },
  ] } }} />);
  expect(document.getElementById(anchorFor(0))?.textContent).toBe("Jip (#4124#4188, 4230)");
  await user.click(screen.getByRole("button", { name: "4230" }));
  expect(openUrl).toHaveBeenCalledWith("https://github.com/FAForever/fa/issues/4230");
});

it("renders a separate code box and copies its exact lines without interpreting markup", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const text = "Jester: T1 Light Gunship (XRA0105)\n  Stinger: T2 Gunship (UEA0203)\n\n<script>literal()</script>";
  const block: ChangelogBlock = { type: "codeBlock", payload: { text } };
  const { rerender } = render(<ChangelogBlockView block={block} anchorId={anchorFor(0)} />);
  const region = screen.getByRole("region", { name: en["changelog.codeBlock"] });
  expect(region.tagName).toBe("PRE");
  expect(region.getAttribute("tabindex")).toBe("0");
  expect(region.querySelector("code")?.textContent).toBe(text);
  expect(region.querySelector("script")).toBeNull();
  expect(noteSections([block], false, en["changelog.historicalBalance"])).toEqual([]);
  const copy = screen.getByRole("button", { name: en["changelog.copyCode"] });
  expect(copy.closest("pre")).toBeNull();
  await user.click(copy);
  expect(writeText).toHaveBeenCalledWith(text);
  expect(screen.getByRole("button", { name: en["changelog.codeCopied"] })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe(en["changelog.codeCopied"]);
  rerender(<ChangelogBlockView block={{ type: "codeBlock", payload: { text: "Other content" } }} anchorId={anchorFor(0)} />);
  expect(screen.getByRole("button", { name: en["changelog.copyCode"] })).toBeTruthy();
});

it("keeps code selectable and reports a failed clipboard request", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Clipboard refused"));
  render(<ChangelogBlockView block={{ type: "codeBlock", payload: { text: "Still selectable\n  indented" } }} anchorId={anchorFor(0)} />);
  await user.click(screen.getByRole("button", { name: en["changelog.copyCode"] }));
  expect(screen.getByRole("status").textContent).toBe(en["changelog.codeCopyFailed"]);
  expect(screen.getByRole("region").textContent).toBe("Still selectable\n  indented");
});

it("keeps historical faction labels in the note while its contents list names sections and units", async () => {
  const user = userEvent.setup();
  const factions: ChangelogBlock[] = ["Aeon", "UEF", "Cybran", "Seraphim", "Sera"].map(text =>
    ({ type: "heading", payload: { level: 3, text } }));
  const block: ChangelogBlock = { type: "historicalBalance", payload: {
    patchId: "3775", sourceUrl: "https://example.invalid/original", unavailable: false,
    blocks: [
      { type: "heading", payload: { level: 2, text: "Date: November 19th 2023" } },
      { type: "heading", payload: { level: 2, text: "Land" } },
      { type: "unit", payload: { name: "T3 Mobile AA", units: [] } },
      ...factions,
      { type: "heading", payload: { level: 2, text: "Navy" } },
      { type: "unit", payload: { name: "T2 Cruisers", units: [] } },
    ],
  } };
  const sections = noteSections([block], false, en["changelog.historicalBalance"]);
  const onJump = vi.fn();
  render(<>
    <ChangelogBlockView block={block} anchorId={anchorFor(0)} />
    <NoteContentsColumn sections={sections} activeSectionId={anchorFor(0)} navRef={createRef<HTMLElement>()} onJump={onJump} />
  </>);
  expect(sections.map(section => section.text)).toEqual([
    en["changelog.historicalBalance"], "Land", "T3 Mobile AA", "Navy", "T2 Cruisers",
  ]);
  const contents = within(screen.getByRole("navigation"));
  for (const faction of ["Aeon", "UEF", "Cybran", "Seraphim", "Sera"]) {
    expect(screen.getByRole("heading", { name: faction, level: 4 })).toBeTruthy();
    expect(contents.queryByRole("button", { name: faction })).toBeNull();
  }
  expect(screen.getByRole("heading", { name: "Date: November 19th 2023" })).toBeTruthy();
  expect(sections.every(section => document.getElementById(section.id))).toBe(true);
  await user.click(contents.getByRole("button", { name: "T2 Cruisers" }));
  expect(onJump).toHaveBeenCalledWith(`${anchorFor(0)}-9`);
});

it("lists the original section's unit groups, but not labels splitting the unit above them", () => {
  // 3761 names many units only by faction, under groups such as "Frigates";
  // 3775 splits "Stinger & Vulthoo" into one label per unit.
  const block: ChangelogBlock = { type: "historicalBalance", payload: {
    patchId: "3761", sourceUrl: "https://example.invalid/original", unavailable: false,
    blocks: [
      { type: "heading", payload: { level: 2, text: "Navy" } },
      { type: "heading", payload: { level: 3, text: "Frigates" } },
      { type: "unit", payload: { name: "Aeon", units: [] } },
      { type: "unit", payload: { name: "Cybran", units: [] } },
      { type: "heading", payload: { level: 2, text: "Air" } },
      { type: "unit", payload: { name: "Stinger & Vulthoo", units: [] } },
      { type: "heading", payload: { level: 3, text: "Stinger" } },
      { type: "heading", payload: { level: 3, text: "Vulthoo" } },
    ],
  } };
  expect(noteSections([block], false, en["changelog.historicalBalance"]).map(section => section.text)).toEqual([
    en["changelog.historicalBalance"], "Navy", "Frigates", "Aeon", "Cybran", "Air", "Stinger & Vulthoo",
  ]);
});

it("keeps ordinary h3 sections in the main note's contents", () => {
  const blocks: ChangelogBlock[] = [
    { type: "heading", payload: { level: 2, text: "Balance" } },
    { type: "heading", payload: { level: 3, text: "Land" } },
  ];
  expect(noteSections(blocks, false, en["changelog.historicalBalance"])).toEqual([
    { id: anchorFor(0), text: "Balance", depth: 1 },
    { id: anchorFor(1), text: "Land", depth: 2 },
  ]);
});

it("nests tier groups and unit links beneath their source headings, and returns to sibling sections", async () => {
  const blocks: ChangelogBlock[] = [
    { type: "heading", payload: { level: 2, text: "Land" } },
    { type: "heading", payload: { level: 3, text: "Tech 3 Land" } },
    { type: "heading", payload: { level: 4, text: "Tanks/Bots" } },
    { type: "unit", payload: { name: "Brick", units: [{ unitId: "URL0303", iconUrl: "https://example.invalid/brick.png" }] } },
    { type: "heading", payload: { level: 4, text: "Snipers" } },
    { type: "heading", payload: { level: 3, text: "Experimentals" } },
    { type: "unit", payload: { name: "Megalith", units: [] } },
    { type: "heading", payload: { level: 2, text: "Air" } },
    { type: "unit", payload: { name: "Jester", units: [] } },
  ];
  const sections = noteSections(blocks, false, en["changelog.historicalBalance"]);
  expect(sections.map(section => [section.text, section.depth])).toEqual([
    ["Land", 1], ["Tech 3 Land", 2], ["Tanks/Bots", 3], ["Brick", 4], ["Snipers", 3],
    ["Experimentals", 2], ["Megalith", 3], ["Air", 1], ["Jester", 2],
  ]);
  const onJump = vi.fn();
  render(<>
    {blocks.map((block, index) => <ChangelogBlockView key={index} block={block} anchorId={anchorFor(index)} />)}
    <NoteContentsColumn sections={sections} activeSectionId={anchorFor(3)} navRef={createRef<HTMLElement>()} onJump={onJump} />
  </>);
  const nav = within(screen.getByRole("navigation", { name: en["changelog.contents"] }));
  const tanks = nav.getByRole("button", { name: "Tanks/Bots" }).closest("li")!;
  const tier = nav.getByRole("button", { name: "Tech 3 Land" }).closest("li")!;
  const experimentals = nav.getByRole("button", { name: "Experimentals" }).closest("li")!;
  expect(within(tanks).getByRole("button", { name: "Brick" }).getAttribute("aria-current")).toBe("location");
  expect(within(tier).getByRole("button", { name: "Snipers" })).toBeTruthy();
  expect(within(tier).queryByRole("button", { name: "Experimentals" })).toBeNull();
  expect(within(experimentals).getByRole("button", { name: "Megalith" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Tanks/Bots", level: 4 })).toBeTruthy();
  expect(sections.every(section => document.getElementById(section.id))).toBe(true);
  await userEvent.setup().click(nav.getByRole("button", { name: "Brick" }));
  expect(onJump).toHaveBeenCalledWith(anchorFor(3));
});

it("labels the complete original separately and connects its contents anchors and source link", async () => {
  const user = userEvent.setup();
  const block: ChangelogBlock = { type: "historicalBalance", payload: {
    patchId: "3776", sourceUrl: "https://github.com/FAForever/patchnotes/blob/revision/balance/3776.html", unavailable: false,
    blocks: [
      { type: "heading", payload: { level: 2, text: "Air" } },
      { type: "unit", payload: { name: "Bombers", units: [{ unitId: null, iconUrl: "https://example.invalid/janus.png" }] } },
    ],
  } };
  const sections = noteSections([block], false, en["changelog.historicalBalance"]);
  render(<ChangelogBlockView block={block} anchorId={anchorFor(0)} />);
  expect(screen.getByRole("region", { name: en["changelog.historicalBalance"] })).toBeTruthy();
  expect(sections.map(section => section.text)).toEqual([en["changelog.historicalBalance"], "Air", "Bombers"]);
  expect(sections.every(section => document.getElementById(section.id))).toBe(true);
  expect(screen.getByRole("heading", { name: "Air", level: 3 })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: en["changelog.historicalBalanceSource"] }));
  expect(openUrl).toHaveBeenCalledWith(block.payload.sourceUrl);
});

it("keeps an unavailable original separate from the summary and retries the same patch", async () => {
  const user = userEvent.setup();
  clearSentCommands();
  render(<ChangelogBlockView anchorId={anchorFor(0)} block={{ type: "historicalBalance", payload: {
    patchId: "3761", sourceUrl: "https://example.invalid/original", unavailable: true, blocks: [],
  } }} />);
  expect(screen.getByRole("status").textContent).toBe(en["changelog.historicalBalanceUnavailable"]);
  await user.click(screen.getByRole("button", { name: en["changelog.retry"] }));
  expect(sentCommands()).toEqual([{ kind: "Changelog", command: { type: "select", payload: { id: "3761" } } }]);
});

it("renders image-only historical headings and gives the contents entry the matching anchor", async () => {
  const user = userEvent.setup();
  const first = "https://raw.githubusercontent.com/FAForever/patchnotes/0d01e845da4d72173492751d153771ee17a0f079/images/titan.png";
  const second = "https://raw.githubusercontent.com/FAForever/patchnotes/0d01e845da4d72173492751d153771ee17a0f079/images/loya.png";
  const block: ChangelogBlock = { type: "unit", payload: { name: "Titan and Loyalist", units: [
    { unitId: null, iconUrl: first }, { unitId: null, iconUrl: second },
  ] } };
  const sections = noteSections([block], false, en["changelog.historicalBalance"]);
  const onJump = vi.fn();
  render(<>
    <ChangelogBlockView block={block} anchorId={anchorFor(0)} />
    <NoteContentsColumn sections={sections} activeSectionId={anchorFor(0)} navRef={createRef<HTMLElement>()} onJump={onJump} />
  </>);

  const heading = document.getElementById(anchorFor(0))!;
  const images = [...heading.querySelectorAll("img")];
  expect(images.map(image => image.getAttribute("src"))).toEqual([first, second]);
  expect(images.every(image => !image.hasAttribute("title"))).toBe(true);
  const jump = screen.getByRole("button", { name: "Titan and Loyalist" });
  expect(jump.querySelector("img")?.getAttribute("src")).toBe(first);
  await user.click(jump);
  expect(onJump).toHaveBeenCalledWith(heading.id);
  fireEvent.error(jump.querySelector("img")!);
  expect(jump.querySelector("img")?.classList.contains("is-missing")).toBe(true);
  expect(jump.textContent).toBe("Titan and Loyalist");
});

it("keeps genuine blueprint tooltips and a readable heading when an image fails", () => {
  const block: ChangelogBlock = { type: "unit", payload: { name: "Titan", units: [
    { unitId: "UEL0303", iconUrl: "https://faforever.github.io/fa/assets/icons/UEL0303_icon.png" },
  ] } };
  render(<ChangelogBlockView block={block} anchorId={anchorFor(0)} />);
  const image = screen.getByTitle("UEL0303");
  fireEvent.error(image);
  expect(image.classList.contains("is-missing")).toBe(true);
  expect(screen.getByText("Titan")).toBeTruthy();
});
