// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { clearSentCommands, sentCommands } from "../../testing/mounted";
import { DEFAULT_MAP_FILTERS, MAP_FILTER_CHOICES } from "../../features/maps/mapVaultFilters";
import { DEFAULT_MOD_FILTERS, MOD_FILTER_CHOICES } from "../../features/mods/modVaultFilters";
import { encodeVaultSearch } from "../../shared/vaultSavedSearches";
import { VaultSavedSearches } from "../../shared/components/VaultSavedSearches";

vi.mock("../../ipc/client");
failOnConsoleError();

it.each(["maps.vault", "mods.vault"])("saves and applies the complete named search for %s", async (list) => {
  const user = userEvent.setup();
  const onApply = vi.fn();
  const defaults = list === "maps.vault" ? DEFAULT_MAP_FILTERS : DEFAULT_MOD_FILTERS;
  const filters = { ...defaults, search: "Saved query", sort: "name" as const };
  const choices = list === "maps.vault" ? MAP_FILTER_CHOICES : MOD_FILTER_CHOICES;
  const saved = encodeVaultSearch({ category: "all", filters });
  render(<VaultSavedSearches list={list} presets={[{ list, name: "My search", query: saved }]}
    category="all" filters={filters} defaults={defaults} categories={[["all", "maps.view.preset.all"]]} choices={choices}
    signedIn onApply={onApply} />);
  clearSentCommands();
  await user.click(screen.getByRole("button", { name: /Saved searches/ }));
  await user.type(screen.getByLabelText("Name of the saved search"), "Another search{Enter}");
  expect(sentCommands()).toEqual([{ kind: "Settings", command: { type: "saveSearchPreset", payload: { preset: { list, name: "Another search", query: saved } } } }]);
  await user.click(screen.getByRole("button", { name: /^My search/ }));
  expect(onApply).toHaveBeenCalledWith({ category: "all", filters });
});

it("keeps personal-upload searches disabled until signed in", async () => {
  const user = userEvent.setup();
  const onApply = vi.fn();
  const saved = encodeVaultSearch({ category: "mine", filters: DEFAULT_MAP_FILTERS });
  render(<VaultSavedSearches list="maps.vault" presets={[{ list: "maps.vault", name: "My uploads", query: saved }]}
    category="all" filters={DEFAULT_MAP_FILTERS} defaults={DEFAULT_MAP_FILTERS} categories={[["all", "maps.view.preset.all"], ["mine", "maps.view.preset.mine"]]}
    choices={MAP_FILTER_CHOICES} signedIn={false} onApply={onApply} />);
  await user.click(screen.getByRole("button", { name: /Saved searches/ }));
  expect(screen.getByRole("button", { name: /^My uploads/ }).hasAttribute("disabled")).toBe(true);
  expect(onApply).not.toHaveBeenCalled();
});
