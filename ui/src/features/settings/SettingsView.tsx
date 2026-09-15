// Settings, as a sidebar of registers.
//
// It was one scroll of fourteen sections with a row of category tabs above it,
// and the report that started this called it a dump. Two things were wrong with
// it and only one of them was the length: every new category made the tab row
// wider, so the structure got worse exactly as the client grew, and the tabs
// only scrolled the one list rather than replacing it, so there was never a
// screen holding one subject and nothing else.
//
// A rail fixes both. It grows downwards, which costs nothing, and it shows one
// register at a time, which is what makes a register a place rather than a
// heading you pass. The shape is the one the issue asked for: a numbered list
// down the side, an index at 00 that reports what each register currently says,
// and a heading on each page naming the register you are in.
//
// Every register stays mounted and all but one are hidden, which is not a
// detail: it is what lets the search read the rows that rendered rather than a
// list maintained beside them (see `settingsSearch`), and it costs no more than
// the previous tab, which rendered all fourteen sections at all times anyway.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import { REGISTERS, REGISTER_ORDER, type RegisterKey } from "./registers";
import { SettingsIndex } from "./SettingsIndex";
import { SettingsRegisterScope, useSettingsIndexEntry } from "./SettingControls";
import {
  clearSettingsRequest,
  pendingSettingsRequest,
  subscribeToSettingsRequest,
} from "./settingsNavigation";
import {
  registerMatches,
  settingsIndexRevision,
  subscribeToSettingsIndex,
} from "./settingsSearch";
import "./settings.css";

/** The index page is a register in the rail, and the one the tab opens on. */
const INDEX: RegisterKey | "index" = "index";
type RailKey = RegisterKey | "index";

/**
 * A register's search words, which are indexed and never drawn.
 *
 * These carry the terms people type that no label on the page uses: "fps",
 * "nickname", "vault". Drawing them would be a paragraph of keyword soup under
 * every heading, so they are contributed to the index and nothing else.
 */
function RegisterKeywords({ text }: { text: string }) {
  useSettingsIndexEntry(text);
  return null;
}

export function SettingsView() {
  const { t } = useTranslation();
  const [active, setActive] = useState<RailKey>(INDEX);
  const [search, setSearch] = useState("");
  const query = search.trim();
  const stageRef = useRef<HTMLDivElement>(null);

  // The index fills in as rows mount, so the match set has to be recomputed
  // when it changes and not only when the query does.
  const revision = useSyncExternalStore(subscribeToSettingsIndex, settingsIndexRevision);
  const matches = useMemo(
    () => new Set(REGISTER_ORDER.filter((key) => registerMatches(key, query))),
    // `revision` is the dependency that matters; it is not read in the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, revision],
  );

  // A search that excludes the register you are looking at would leave you
  // reading a page the rail says has no matches, so move to the first one that
  // does. Typing on the index page leaves you there: that page lists them all,
  // which is the useful answer while a query is still half typed.
  useEffect(() => {
    if (!query || active === INDEX) return;
    if (matches.has(active as RegisterKey)) return;
    const first = REGISTER_ORDER.find((key) => matches.has(key));
    if (first) setActive(first);
  }, [query, matches, active]);

  // Each register is its own page, so it starts at the top like one.
  useEffect(() => {
    stageRef.current?.scrollTo({ top: 0 });
  }, [active]);

  // A notification that sends you into Settings names the register it meant.
  // Consumed here rather than acted on by the sender, because the sender has
  // navigated to the tab and this component may not have existed yet.
  const requested = useSyncExternalStore(subscribeToSettingsRequest, pendingSettingsRequest);
  useEffect(() => {
    if (!requested) return;
    setActive(requested);
    setSearch("");
    clearSettingsRequest();
  }, [requested]);

  const open = (key: RailKey) => {
    setActive(key);
  };

  return (
    <div className="settings-view">
      <nav className="settings-rail" aria-label={t("settings.registers.aria")}>
        <div className="settings-rail-head">
          <h2 className="view-title">{t("settings.title")}</h2>
          <label className="settings-search-field">
            <Icon name="search" size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("settings.search.placeholder")}
              aria-label={t("settings.search.placeholder")}
            />
            {search && (
              <button
                type="button"
                aria-label={t("settings.search.clearAria")}
                title={t("settings.search.clearTitle")}
                onClick={() => setSearch("")}
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </label>
        </div>

        <ul className="settings-rail-list">
          <li>
            <button
              type="button"
              className={`settings-rail-item${active === INDEX ? " is-active" : ""}`}
              aria-current={active === INDEX ? "page" : undefined}
              onClick={() => open(INDEX)}
            >
              <span className="settings-rail-no">00</span>
              <span className="settings-rail-name">{t("settings.register.index.title")}</span>
            </button>
          </li>
          {REGISTER_ORDER.map((key) => {
            const register = REGISTERS[key];
            // Dimmed rather than removed: a rail that reorders itself while
            // somebody types loses the shape they were navigating by, and the
            // numbers stop meaning anything if they move.
            const dimmed = query !== "" && !matches.has(key);
            return (
              <li key={key}>
                <button
                  type="button"
                  className={`settings-rail-item${active === key ? " is-active" : ""}${dimmed ? " is-dimmed" : ""}`}
                  aria-current={active === key ? "page" : undefined}
                  onClick={() => open(key)}
                >
                  <span className="settings-rail-no">{register.no}</span>
                  <span className="settings-rail-name">{t(register.title)}</span>
                </button>
              </li>
            );
          })}
        </ul>

        <p className="settings-rail-foot muted">
          {query
            ? t("settings.search.registerMatches", { count: matches.size })
            : t("settings.registers.count", { count: REGISTER_ORDER.length })}
        </p>
      </nav>

      <div className="settings-stage" ref={stageRef}>
        <div className="settings-register" hidden={active !== INDEX}>
          <header className="settings-register-head">
            <span className="settings-register-eyebrow">{t("settings.register.eyebrow")}</span>
            <h3 className="settings-register-title">{t("settings.register.index.title")}</h3>
            <p className="muted">{t("settings.register.index.description")}</p>
          </header>
          <SettingsRegisterScope register="index">
            <SettingsIndex onOpen={open} />
          </SettingsRegisterScope>
        </div>

        {REGISTER_ORDER.map((key) => {
          const register = REGISTERS[key];
          return (
            <div className="settings-register" key={key} hidden={active !== key}>
              <header className="settings-register-head">
                <span className="settings-register-eyebrow">
                  {t("settings.register.eyebrowNumbered", { no: register.no })}
                </span>
                <h3 className="settings-register-title">{t(register.title)}</h3>
                <p className="muted">{t(register.description)}</p>
              </header>
              <SettingsRegisterScope register={key}>
                <RegisterKeywords text={t(register.keywords)} />
                {register.panels.map((Panel, index) => (
                  <Panel key={index} />
                ))}
              </SettingsRegisterScope>
            </div>
          );
        })}
      </div>
    </div>
  );
}
