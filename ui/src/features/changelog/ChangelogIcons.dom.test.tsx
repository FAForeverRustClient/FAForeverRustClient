// @vitest-environment happy-dom

import { createRef } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { UnitIcons } from "../../ipc/native";
import { ChangelogIcon } from "../../shared/components/ChangelogIcon";
import { ChangelogIllustration } from "../../shared/components/ChangelogIllustration";
import { ChangelogBlockView } from "../../shared/components/ChangelogBlocks";
import { NoteContentsColumn } from "./noteReader";
import { failOnConsoleError } from "../../testing/consoleGuard";
import "../../testing/mounted";

const { readUnitIcons } = vi.hoisted(() => ({ readUnitIcons: vi.fn() }));
vi.mock("../../ipc/native", () => ({ native: { readUnitIcons } }));
vi.mock("../../ipc/client");
failOnConsoleError();

const clean = "https://faforever.github.io/fa/assets/icons/";
const legacy = "https://raw.githubusercontent.com/FAForever/patchnotes/0d01e845da4d72173492751d153771ee17a0f079/images/";
const local = (id: string) => `http://unit-icon.localhost/unit-${id}`;

it("shares one local catalogue across the article, caption and contents, including immediate remounts", async () => {
  let resolve!: (icons: UnitIcons) => void;
  readUnitIcons.mockReturnValue(new Promise<UnitIcons>(finish => { resolve = finish; }));
  const source = legacy + "nukesub.png";
  const view = render(<>
    <ChangelogBlockView anchorId="unit" block={{ type: "unit", payload: {
      name: "Submarines", units: [{ unitId: "UAS0304", iconUrl: source }],
    } }} />
    <ChangelogIllustration illustration={{ type: "unit", iconUrl: source }} className="changelog-unit-icon" size={48} />
    <NoteContentsColumn sections={[{ id: "unit", depth: 2, text: "Submarines", iconUrl: source }]}
      activeSectionId="unit" navRef={createRef<HTMLElement>()} onJump={vi.fn()} />
  </>);
  expect(readUnitIcons).toHaveBeenCalledTimes(1);
  const pending = view.container.querySelectorAll("img");
  expect(pending).toHaveLength(3);
  expect([...pending].map(image => image.getAttribute("loading"))).toEqual(["lazy", "lazy", "eager"]);
  for (const image of pending) expect(image.hasAttribute("src")).toBe(false);
  await act(async () => {
    resolve({ units: Object.fromEntries(["UES0304", "UEL0303", "UEL0203", "UEB4301", "UEB0102", "UEB0103", "URL0401", "ZZZ9999"].map(id => [id, local(id)])), strategic: {} });
    await Promise.resolve();
  });
  for (const image of view.container.querySelectorAll("img")) {
    expect(image.getAttribute("src")).toBe(local("UES0304"));
    expect(image.classList.contains("changelog-icon-background-sea")).toBe(true);
  }
  view.unmount();
  const returned = render(<ChangelogIcon source={source} className="changelog-unit-icon" size={48} />);
  expect(returned.container.querySelector("img")?.getAttribute("src")).toBe(local("UES0304"));
  expect(readUnitIcons).toHaveBeenCalledTimes(1);
});

it.each([
  ["UEB4301", "land"], ["UEB0102", "air"], ["UEB0103", "sea"], ["URL0401", "amph"],
])("restores %s's game background in both picture sizes", (id, background) => {
  const view = render(<>
    <ChangelogIcon source={clean + id + "_icon.png"} className="changelog-unit-icon" size={48} />
    <ChangelogIcon source={clean + id + "_icon.png"} className="changelog-toc-icon" size={24} loading="eager" />
  </>);
  for (const picture of view.container.querySelectorAll("img")) {
    expect(picture.getAttribute("src")).toBe(local(id));
    expect(picture.classList.contains(`changelog-icon-background-${background}`)).toBe(true);
  }
});

it("preserves a valid local portrait when its background is unknown", () => {
  const source = clean + "ZZZ9999_icon.png";
  const view = render(<ChangelogIcon source={source} className="changelog-unit-icon" size={48} />);
  const picture = view.container.querySelector("img")!;
  expect(picture.getAttribute("src")).toBe(local("ZZZ9999"));
  expect(picture.classList.contains("changelog-icon-background")).toBe(false);
});

it.each([false, true])("requests the Shield Assist contents picture without selecting it (historical: %s)", historical => {
  const onJump = vi.fn();
  const source = clean + "UEB4301_icon.png";
  const view = render(<NoteContentsColumn sections={[
    { id: "engine", depth: 1, text: "Engine" },
    { id: "shield-assist", depth: 2, text: "Shield Assist", iconUrl: historical ? undefined : source,
      illustration: historical ? { type: "unit", unitId: "UEB4301", iconUrl: source } : undefined },
  ]} activeSectionId="engine" navRef={createRef<HTMLElement>()} onJump={onJump} />);
  const image = view.container.querySelector("img")!;
  expect(onJump).not.toHaveBeenCalled();
  expect(image.getAttribute("src")).toBe(local("UEB4301"));
  expect(image.getAttribute("loading")).toBe("eager");
  fireEvent.error(image);
  const fallback = view.container.querySelector("img")!;
  expect(fallback.getAttribute("src")).toBe(source);
  expect(fallback.getAttribute("loading")).toBe("eager");
  expect(onJump).not.toHaveBeenCalled();
});

it("falls back from a broken local picture and recovers when the unit changes", () => {
  const view = render(<ChangelogIcon source={clean + "UEL0303_icon.png"} className="changelog-toc-icon" size={24} />);
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe(local("UEL0303"));
  fireEvent.error(view.container.querySelector("img")!);
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe(clean + "UEL0303_icon.png");
  expect(view.container.querySelector("img")?.classList.contains("changelog-icon-background")).toBe(false);
  expect(view.container.querySelector("img")?.classList.contains("is-missing")).toBe(false);
  fireEvent.error(view.container.querySelector("img")!);
  expect(view.container.querySelector("img")?.classList.contains("is-missing")).toBe(true);
  view.rerender(<ChangelogIcon source={clean + "UEL0203_icon.png"} className="changelog-toc-icon" size={24} />);
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe(local("UEL0203"));
  expect(view.container.querySelector("img")?.classList.contains("is-missing")).toBe(false);
});

it("keeps web artwork for units absent from the install and for enhancement glyphs", () => {
  const view = render(<>
    <ChangelogIcon source={clean + "XES0205_icon.png"} className="changelog-unit-icon" size={48} />
    <ChangelogIcon source={legacy + "Enhancements/uef/teleport.png"} className="changelog-unit-icon" size={48} />
  </>);
  expect([...view.container.querySelectorAll("img")].map(image => image.getAttribute("src"))).toEqual([
    clean + "XES0205_icon.png", legacy + "Enhancements/uef/teleport.png",
  ]);
  expect(readUnitIcons).toHaveBeenCalledTimes(1);
});
