// @vitest-environment happy-dom

import { createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ChangelogBlock } from "../../ipc/bindings";
import { anchorFor, noteSections, NoteContentsColumn } from "./noteReader";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { clearSentCommands, sentCommands } from "../../testing/mounted";
import { en } from "../../i18n/catalog/en";
import { ChangelogBlockView } from "../../shared/components/ChangelogBlocks";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("../../ipc/native", () => ({ native: { openUrl } }));
vi.mock("../../ipc/client");
failOnConsoleError();

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
