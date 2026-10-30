// @vitest-environment happy-dom

import { render, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useUnitIcons } from "./useUnitIcons";
import { ChangelogIcon } from "./components/ChangelogIcon";
import { failOnConsoleError } from "../testing/consoleGuard";
import "../testing/mounted";

const { readUnitIcons } = vi.hoisted(() => ({ readUnitIcons: vi.fn() }));
vi.mock("../ipc/native", () => ({ native: { readUnitIcons } }));
vi.mock("../ipc/client");
failOnConsoleError();

it("skips unknown artwork, and retains the web fallback when the local catalogue is unavailable", async () => {
  const unknown = render(<ChangelogIcon source="/assets/changelog/categories/land.png" className="changelog-unit-icon" size={48} />);
  expect(readUnitIcons).not.toHaveBeenCalled();
  unknown.unmount();
  readUnitIcons.mockRejectedValue(new Error("No desktop bridge"));
  const lookup = renderHook(() => useUnitIcons());
  await waitFor(() => expect(lookup.result.current).toEqual({ units: {}, strategic: {} }));
  lookup.unmount();
  const returned = renderHook(() => useUnitIcons());
  expect(returned.result.current).toEqual({ units: {}, strategic: {} });
  const source = "https://faforever.github.io/fa/assets/icons/UEL0303_icon.png";
  const picture = render(<ChangelogIcon source={source} className="changelog-unit-icon" size={48} />);
  expect(picture.container.querySelector("img")?.getAttribute("src")).toBe(source);
  expect(readUnitIcons).toHaveBeenCalledTimes(1);
});
