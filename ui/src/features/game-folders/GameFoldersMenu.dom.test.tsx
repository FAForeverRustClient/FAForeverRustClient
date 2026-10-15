// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { seedStore } from "../../testing/mounted";
import { GameFoldersMenu } from "./GameFoldersMenu";

vi.mock("../../ipc/client");

it("opens from the keyboard, navigates its entries and returns focus on Escape", async () => {
  seedStore((state) => state);
  const user = userEvent.setup();
  render(<><GameFoldersMenu /><button>After folders</button></>);
  const trigger = screen.getByRole("button", { name: /game folders/i });
  trigger.focus();
  await user.keyboard("{Enter}");
  const entries = screen.getAllByRole("menuitem");
  expect(document.activeElement).toBe(entries[0]);
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(entries[1]);
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(entries[entries.length - 1]);
  await user.keyboard("{Home}{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}{Tab}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "After folders" }));
});
