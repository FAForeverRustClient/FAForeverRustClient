import { afterEach, expect, it } from "vitest";
import { catalogueLoaded, CATALOGUES, loadCatalogue } from "./catalog";
import { getLocale, initializeLocale, resetLocaleForTests, setLocale } from "./store";

afterEach(() => resetLocaleForTests());

it("loads and shares only the requested catalogue", async () => {
  expect(catalogueLoaded("en")).toBe(true);
  expect(Object.keys(CATALOGUES.de)).toHaveLength(0);
  const first = loadCatalogue("de");
  expect(loadCatalogue("de")).toBe(first);
  await first;
  expect(Object.keys(CATALOGUES.de).length).toBeGreaterThan(100);
  expect(catalogueLoaded("pl")).toBe(false);
});

it("keeps the latest selection when an earlier catalogue is still loading", async () => {
  setLocale("fr");
  setLocale("en");
  await loadCatalogue("fr");
  expect(getLocale()).toBe("en");
});

it("prepares a remembered language before the first render", async () => {
  resetLocaleForTests("ru");
  await initializeLocale();
  expect(getLocale()).toBe("ru");
  expect(catalogueLoaded("ru")).toBe(true);
});
