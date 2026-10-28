// Vitest setup file (see `vitest.config.ts`): every language, loaded before
// each test file, so a test can read any catalogue synchronously. The lazy
// loading itself is covered by `i18n/loading.test.ts` on fresh modules.
import { beforeAll } from "vitest";
import { loadCatalogue } from "../i18n/catalog";
import { LOCALE_KEYS } from "../i18n/locales";

beforeAll(() => Promise.all(LOCALE_KEYS.map(loadCatalogue)));
