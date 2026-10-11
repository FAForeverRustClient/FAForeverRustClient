// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { applyEvent, clearSentCommands, sentCommands } from "../../testing/mounted";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { GenerateMapModal } from "./GenerateMapModal";

vi.mock("../../ipc/client");
failOnConsoleError();

describe("generator composition", () => {
  it("keeps team and spawn edits atomic and passes the resulting map to its opener", () => {
    const close = vi.fn();
    const generated = vi.fn();
    render(<GenerateMapModal onClose={close} onGenerated={generated} />);
    const teams = screen.getByRole("combobox", { name: "Teams" });
    fireEvent.keyDown(teams, { key: "4" });
    fireEvent.keyDown(teams, { key: "Enter" });
    expect(screen.getByRole("combobox", { name: "Spawns" }).textContent).toBe("4");
    clearSentCommands();
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    const command = sentCommands().find((entry) => entry.kind === "MapGenerator" && entry.command.type === "generate");
    if (command?.kind !== "MapGenerator" || command.command.type !== "generate") throw new Error("no generation request");
    expect(command.command.payload.options.numTeams).toBe(4);
    expect(command.command.payload.options.spawnCount).toBe(4);
    applyEvent({
      kind: "MapGenerator", event: {
        type: "statusChanged", payload: {
          status: { type: "generated", payload: { maps: ["generated_test"] } },
        }
      }
    });
    expect(screen.getByText("generated_test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use map" }));
    expect(generated).toHaveBeenCalledWith(["generated_test"]);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
