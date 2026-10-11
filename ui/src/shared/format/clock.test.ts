import { afterEach, describe, expect, it } from "vitest";
import { resetLocaleForTests, setLocale } from "../../i18n/store";
import { useAppStore } from "../../store/store";
import { hourCycleOptions, uses24HourClock } from "./clock";
import { formatDateTime, formatShortDateTime, formatTime } from "./dates";

const initial = useAppStore.getState().state;

function setClock(use24HourTime: boolean) {
  const { state } = useAppStore.getState();
  useAppStore.setState({
    state: {
      ...state,
      settings: { ...state.settings, chat: { ...state.settings.chat, use24HourTime } },
    },
  });
}

// A local afternoon, so the hour is past twelve whatever zone runs the suite.
const AFTERNOON = new Date(2026, 9, 4, 18, 30).getTime();

afterEach(() => {
  useAppStore.setState({ state: initial });
  resetLocaleForTests();
});

describe("the player's clock (issue 425)", () => {
  it("defaults to the 24-hour clock, as the setting does", () => {
    expect(uses24HourClock()).toBe(true);
    expect(hourCycleOptions()).toEqual({ hourCycle: "h23" });
    expect(formatTime(AFTERNOON)).toBe("18:30");
  });

  it("follows the switch everywhere a time of day is printed", () => {
    setClock(false);
    expect(hourCycleOptions()).toEqual({ hourCycle: "h12" });
    expect(formatTime(AFTERNOON)).toMatch(/^6:30\sPM$/);
    expect(formatDateTime(AFTERNOON)).toMatch(/6:30\sPM$/);
    expect(formatShortDateTime(AFTERNOON)).toMatch(/06:30\sPM$/);

    setClock(true);
    expect(formatTime(AFTERNOON)).toBe("18:30");
    expect(formatDateTime(AFTERNOON)).toMatch(/18:30$/);
    expect(formatShortDateTime(AFTERNOON)).toMatch(/18:30$/);
  });

  it("overrides the clock of the selected language", () => {
    // German would print 18:30 on its own; the switch still wins.
    setLocale("de");
    setClock(false);
    expect(formatTime(AFTERNOON)).toMatch(/6:30\s?PM$/i);
  });

  it("takes an explicit value from a component that subscribed to it", () => {
    setClock(false);
    expect(formatTime(AFTERNOON, "", true)).toBe("18:30");
  });
});
