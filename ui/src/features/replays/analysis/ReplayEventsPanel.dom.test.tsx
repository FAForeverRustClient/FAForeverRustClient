// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ReplayAnalysis, ReplayArmy } from "../../../ipc/bindings";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import "../../../testing/mounted";
import { ReplayEventsPanel } from "./ReplayEventsPanel";

vi.mock("../../../ipc/client");
vi.mock("../../../shared/useUnitIcons", () => ({ useUnitIcons: () => ({ units: { UEL0001: "unit-icon:unit-UEL0001" }, strategic: {} }) }));
vi.mock("../../../ipc/native", () => ({ native: { enhancementIconUrl: (_faction: string, name: string) => `unit-icon:enhancement-${name}` } }));
failOnConsoleError();

const army = (source: number, name: string): ReplayArmy => ({ source, name, faction: 1, armyName: `ARMY_${source}`, color: 1, team: source + 2, startSpot: 1, human: true, country: "", clan: "", rating: null });
const analysis = { armies: [army(0, "Blue"), army(1, "Red"), army(2, "Green")], activity: [], notices: [
  { tick: 100, source: 0, text: "T2 done!" }, { tick: 110, source: 1, text: "T3 done!" }, { tick: 120, source: 2, text: "RAS done!" }, { tick: 140, source: 1, text: "Fatboy done!" },
] } as unknown as ReplayAnalysis;

it("combines multiple players and event categories, and shows enhancement artwork and optional teams", async () => {
  const user = userEvent.setup();
  render(<ReplayEventsPanel analysis={analysis} />);
  expect(screen.getByText("RAS done!")).toBeDefined();
  expect(document.querySelector('img[src="unit-icon:enhancement-aes_btn_up"]')).not.toBeNull();
  await user.click(screen.getByRole("button", { name: /^Players:/ }));
  const players = screen.getByRole("group", { name: "Players" });
  await user.click(within(players).getByRole("checkbox", { name: "Blue" }));
  await user.click(within(players).getByRole("checkbox", { name: "Red" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByText("RAS done!")).toBeNull();
  expect(screen.getByText("Fatboy done!")).toBeDefined();
  await user.click(screen.getByRole("button", { name: /^Event types:/ }));
  await user.click(screen.getByRole("checkbox", { name: "ACU upgrades" }));
  await user.keyboard("{Escape}");
  expect(screen.getByText("T2 done!")).toBeDefined();
  expect(screen.getByText("T3 done!")).toBeDefined();
  expect(screen.queryByText("Fatboy done!")).toBeNull();
  await user.click(screen.getByRole("checkbox", { name: "Show teams" }));
  expect(screen.getByText("Team 1")).toBeDefined();
  expect(screen.getByText("Team 2")).toBeDefined();
});

it("falls back to commander artwork when an enhancement picture is unavailable", () => {
  render(<ReplayEventsPanel analysis={analysis} />);
  const picture = document.querySelector('img[src="unit-icon:enhancement-aes_btn_up"]');
  expect(picture).not.toBeNull();
  fireEvent.error(picture!);
  expect(document.querySelector('img[src="unit-icon:unit-UEL0001"]')).not.toBeNull();
});
