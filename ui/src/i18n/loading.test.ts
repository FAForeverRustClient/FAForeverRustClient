import { beforeEach, expect, it, vi } from "vitest";

// The setup file loads every catalogue; these cases need the modules as the
// client starts them, with English only.
let catalog: typeof import("./catalog");
let store: typeof import("./store");

beforeEach(async () => {
  vi.resetModules();
  catalog = await import("./catalog");
  store = await import("./store");
  store.resetLocaleForTests();
});

it("loads and shares only the requested catalogue", async () => {
  expect(catalog.catalogueLoaded("en")).toBe(true);
  expect(Object.keys(catalog.CATALOGUES.de)).toHaveLength(0);
  const first = catalog.loadCatalogue("de");
  expect(catalog.loadCatalogue("de")).toBe(first);
  await first;
  expect(Object.keys(catalog.CATALOGUES.de).length).toBeGreaterThan(100);
  expect(catalog.catalogueLoaded("pl")).toBe(false);
});

it("keeps the latest selection when an earlier catalogue is still loading", async () => {
  store.setLocale("fr");
  store.setLocale("en");
  await catalog.loadCatalogue("fr");
  expect(store.getLocale()).toBe("en");
});

it("prepares a remembered language before the first render", async () => {
  store.resetLocaleForTests("ru");
  expect(catalog.catalogueLoaded("ru")).toBe(false);
  await store.initializeLocale();
  expect(store.getLocale()).toBe("ru");
  expect(catalog.catalogueLoaded("ru")).toBe(true);
});
