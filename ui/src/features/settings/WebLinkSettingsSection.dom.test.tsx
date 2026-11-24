// @vitest-environment happy-dom
//
// The web client's switch: offered where the web link can work, and left out
// of a client without a lobby, which the backend never links.

import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { seedStore } from "../../testing/mounted";
import { WebLinkSettingsSection } from "./WebLinkSettingsSection";

vi.mock("../../ipc/client");

failOnConsoleError();

it("offers the switch to a client with a lobby", () => {
  seedStore((state) => state);
  render(<WebLinkSettingsSection />);
  expect(screen.getByRole("checkbox", { name: en["settings.webLink.enabled"] })).toBeTruthy();
});

it("leaves the section out of a client without a lobby", () => {
  seedStore((state) => ({ ...state, lobby: { ...state.lobby, unavailable: "notInAndroidClient" } }));
  render(<WebLinkSettingsSection />);
  expect(screen.queryByText(en["settings.section.webLink.title"])).toBeNull();
  expect(screen.queryByRole("checkbox", { name: en["settings.webLink.enabled"] })).toBeNull();
});
