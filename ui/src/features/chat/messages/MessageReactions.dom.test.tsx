// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import "../../../testing/mounted";
import { MessageReactions } from "./MessageReactions";

vi.mock("../../../ipc/client");
failOnConsoleError();

it("renders Java aliases and removes the original wire reaction", async () => {
  const user = userEvent.setup();
  const onUnreact = vi.fn();
  render(<MessageReactions msgid="m1" self="Ada" reactions={[{ emoji: ":+1:", senders: ["Ada"] }]} onReact={vi.fn()} onUnreact={onUnreact} />);
  expect(screen.getByText("👍")).toBeDefined();
  await user.click(screen.getByRole("button", { name: /Remove/ }));
  expect(onUnreact).toHaveBeenCalledWith(":+1:");
});

it("offers faction reactions using Java-compatible wire codes", async () => {
  const user = userEvent.setup();
  const onReact = vi.fn();
  render(<MessageReactions msgid="m1" self="Ada" reactions={[]} onReact={onReact} onUnreact={vi.fn()} pickerOpen onTogglePicker={vi.fn()} />);
  await user.click(screen.getByRole("menuitem", { name: "UEF" }));
  expect(onReact).toHaveBeenCalledWith(":uef:");
});
