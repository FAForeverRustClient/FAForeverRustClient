import { beforeAll } from "vitest";
import { loadCatalogue } from "../i18n/catalog";
import { LOCALE_KEYS } from "../i18n/locales";

beforeAll(() => Promise.all(LOCALE_KEYS.map(loadCatalogue)));
