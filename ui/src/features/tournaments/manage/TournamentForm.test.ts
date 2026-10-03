// `rejectionOf` is a hand-written twin of `TourneyDraft::rejection`, and it is
// what stops an organiser filling in a long form only to be told the name was
// missing.
//
// It *is* now held to the Rust version: `reducer.conformance.test.ts` replays
// what `TourneyDraft::rejection` actually returns, including which refusal comes
// first when a draft has two problems. These cases stay for what they say out
// loud about each rule.

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { draftOf, FormFrame, TournamentForm } from "./TournamentForm";
import { rejectionOf } from "../../../shared/rules/tourneyRules";
import { tourney } from "../fixtures";
import type { TourneyDraft } from "../../../ipc/bindings";

const draft = (over: Partial<TourneyDraft> = {}): TourneyDraft => ({
  ...draftOf(tourney()),
  name: "Weekend Cup",
  teamSize: 2,
  ...over,
});

describe("rejectionOf", () => {
  it("accepts an ordinary draft", () => {
    expect(rejectionOf(draft())).toBeNull();
  });

  it("wants a name that is more than whitespace", () => {
    expect(rejectionOf(draft({ name: "   " }))).toBe("nameRequired");
  });

  it("keeps the team size inside what the server takes", () => {
    expect(rejectionOf(draft({ teamSize: 0 }))).toBe("teamSizeOutOfRange");
    expect(rejectionOf(draft({ teamSize: 7 }))).toBe("teamSizeOutOfRange");
    expect(rejectionOf(draft({ teamSize: 6 }))).toBeNull();
  });

  it("refuses a rating range that excludes everyone", () => {
    const gated = draft({ rating: { min: 2000, max: 1500, maxTeam: null, cap: null } });
    expect(rejectionOf(gated)).toBe("ratingRangeInverted");
  });

  it("refuses a rating gate on an unrated tournament", () => {
    // An unrated event never fetches a rating, so a gate could only ever refuse
    // every signup, and it would do it with a confusing message.
    const unrated = draft({
      ratingKind: "none",
      rating: { min: 1500, max: null, maxTeam: null, cap: null },
    });
    expect(rejectionOf(unrated)).toBe("ratingGateWithoutRating");
    expect(rejectionOf(draft({ ratingKind: "none" }))).toBeNull();
  });

  it("refuses a signup window that closes before it opens", () => {
    const inverted = draft({ signupOpensAt: 1_787_400_000, signupClosesAt: 1_787_300_000 });
    expect(rejectionOf(inverted)).toBe("signupWindowInverted");
  });

  it("takes a window with only one end set", () => {
    expect(rejectionOf(draft({ signupClosesAt: 1_787_300_000 }))).toBeNull();
    expect(rejectionOf(draft({ signupOpensAt: 1_787_300_000 }))).toBeNull();
  });
});

describe("draftOf", () => {
  it("carries the fields an edit may still change", () => {
    const event = tourney({
      name: "Autumn Invitational",
      description: "Four invited players.",
      teamSize: 3,
      signupMode: "invite",
      ratingKind: "ladder1v1",
      ratingDate: 1_787_000_000,
      eventDate: 1_787_421_600,
    });
    const from = draftOf(event);
    expect(from.name).toBe("Autumn Invitational");
    expect(from.description).toBe("Four invited players.");
    expect(from.eventDate).toBe(1_787_421_600);
    expect(from.ratingDate).toBe(1_787_000_000);
    // Read off the event, never assumed. `edit_info` resends both, so a
    // default here would reopen an invite-only event and reset its rating type
    // the first time somebody corrected a typo in the name.
    expect(from.signupMode).toBe("invite");
    expect(from.ratingKind).toBe("ladder1v1");
    // Format fields come along so the form can show them, even though editing
    // never sends them.
    expect(from.teamSize).toBe(3);
  });
});

describe("TournamentForm frame", () => {
  /**
   * The element type the form renders as its root, on each of several renders.
   *
   * The form is called from inside a probe component so its hooks have a
   * render to belong to; the probe itself renders nothing.
   */
  function rootTypes(inline: boolean, names: string[]): unknown[] {
    const seen: unknown[] = [];
    function Probe({ name }: { name: string }) {
      const root = TournamentForm({
        event: tourney({ name }),
        series: [],
        busy: false,
        inline,
        onSubmit: () => {},
        onClose: () => {},
      }) as ReactElement;
      seen.push(root.type);
      return null;
    }
    for (const name of names) renderToStaticMarkup(createElement(Probe, { name }));
    return seen;
  }

  it("keeps one component type across renders, so edits do not remount the fields", () => {
    // A frame built inside the form was a new type on every render, which
    // made React unmount and remount every field on every keystroke.
    for (const inline of [true, false]) {
      const [first, second] = rootTypes(inline, ["Weekend Cup", "Weekend Cup 2"]);
      expect(first).toBe(FormFrame);
      expect(second).toBe(first);
    }
  });

  it("frames an inline form as the section itself", () => {
    const html = renderToStaticMarkup(
      createElement(FormFrame, { inline: true, title: "Edit", onClose: () => {}, children: "body" }),
    );
    expect(html).toBe('<div class="tournament-form is-inline">body</div>');
  });
});
