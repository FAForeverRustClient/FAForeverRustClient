import { describe, expect, it } from "vitest";
import type { NotificationKind, NotificationSound, NotificationSoundChoices } from "../../ipc/bindings";
import {
  notificationTonePlan,
  soundForKind,
  tonePeakGain,
  tonePlanDuration,
} from "./notificationSound";

const AUDIBLE: NotificationSound[] = ["soft", "chime", "ping", "alert"];

// Not the defaults, which are all chime: a mapping test needs the twelve
// fields to be distinguishable, which is exactly what the defaults are not.
const CHOICES: NotificationSoundChoices = {
  matchFound: "alert",
  privateMessage: "ping",
  mention: "ping",
  friendOnline: "soft",
  friendOffline: "soft",
  friendPlaying: "soft",
  newCustomGame: "soft",
  gameFull: "alert",
  gameLaunched: "chime",
  reviewReminder: "soft",
  partyInvite: "alert",
  other: "silent",
};

describe("the shipped tones", () => {
  it("gives silent no plan at all, which is how it stays quiet", () => {
    expect(notificationTonePlan("silent")).toBeNull();
  });

  it("keeps every tone short, quiet and softly attacked", () => {
    for (const sound of AUDIBLE) {
      const plan = notificationTonePlan(sound);
      expect(plan, sound).not.toBeNull();
      if (!plan) continue;
      expect(plan.attackSeconds, sound).toBeGreaterThan(0);
      expect(plan.attackSeconds, sound).toBeLessThan(0.03);
      // Loud enough to be heard at all, which is the bug these numbers fix,
      // and far enough from full scale that nothing can clip.
      expect(plan.peakGain, sound).toBeGreaterThanOrEqual(0.1);
      expect(plan.peakGain, sound).toBeLessThanOrEqual(0.35);
      // Long enough to be heard, short enough not to talk over the game.
      expect(tonePlanDuration(plan), sound).toBeLessThanOrEqual(0.4);
      expect(plan.notes.length, sound).toBeGreaterThan(0);
    }
  });

  it("keeps chime the pitch and timbre it has always been", () => {
    // Anybody who liked one sound for everything sets every row to chime, so
    // the tone itself is fixed. Its *level* is not: it was 0.06, which nobody
    // could hear, and the report behind that change is the whole reason this
    // module was revisited.
    const chime = notificationTonePlan("chime");
    expect(chime?.notes).toEqual([{ frequency: 523.25, startSeconds: 0, durationSeconds: 0.2 }]);
    expect(chime?.partials.map((partial) => partial.gain)).toEqual([1, 0.2, 0.06]);
  });

  it("keeps the four graded by how much attention they ask for", () => {
    const gains = AUDIBLE.map((sound) => notificationTonePlan(sound)?.peakGain ?? 0);
    // `soft` is the quietest and `alert` the loudest; `ping` sits under `chime`
    // because 880 Hz already carries further than 523 at the same amplitude.
    expect(gains[0]).toBeLessThan(gains[2]);
    expect(gains[2]).toBeLessThan(gains[3]);
    expect(gains[1]).toBeLessThan(gains[3]);
  });

  it("scales a tone by the volume setting and stops at zero", () => {
    const chime = notificationTonePlan("chime");
    if (!chime) throw new Error("chime has no plan");
    expect(tonePeakGain(chime, 100)).toBeCloseTo(chime.peakGain);
    expect(tonePeakGain(chime, 50)).toBeCloseTo(chime.peakGain / 2);
    // Zero is the setting that means no sound, and out-of-range values are
    // clamped rather than trusted: `playNotificationSound` plays nothing for a
    // peak of zero, which is how the slider's bottom end stays silent.
    expect(tonePeakGain(chime, 0)).toBe(0);
    expect(tonePeakGain(chime, -20)).toBe(0);
    expect(tonePeakGain(chime, 400)).toBeCloseTo(chime.peakGain);
  });

  it("separates the tones by pitch, not only by volume", () => {
    // Two sounds that differ only in gain are the same sound twice at these
    // durations. Each tone starts on a pitch no other one starts on.
    const openings = AUDIBLE.map((sound) => notificationTonePlan(sound)?.notes[0]?.frequency);
    expect(new Set(openings).size).toBe(AUDIBLE.length);
  });

  it("makes alert the one that moves, which is what carries across a room", () => {
    const alert = notificationTonePlan("alert");
    expect(alert?.notes.length).toBeGreaterThan(1);
    const [first, second] = alert?.notes ?? [];
    expect(second?.frequency).toBeGreaterThan(first?.frequency ?? 0);
    // The second note starts before the first has finished: a gap would read as
    // two notifications rather than one sound.
    expect(second?.startSeconds).toBeLessThan(first?.durationSeconds ?? 0);
  });
});

describe("which tone a notification plays", () => {
  it("uses the choice made for that kind", () => {
    expect(soundForKind("matchFound", CHOICES)).toBe("alert");
    expect(soundForKind("friendOnline", CHOICES)).toBe("soft");
    expect(soundForKind("privateMessage", CHOICES)).toBe("ping");
  });

  it("falls to the catch-all for a kind with no switch of its own", () => {
    const noSwitch: NotificationKind[] = [
      "serverNotice",
      "serverWarning",
      "mapGenerated",
      "clientUpdate",
      "replayAvailable",
      "reportSubmitted",
      "eventReminder",
      "gameCacheAlert",
      "error",
    ];
    for (const kind of noSwitch) {
      expect(soundForKind(kind, CHOICES), kind).toBe(CHOICES.other);
    }
  });

  it("honours silent, so a kind can be seen and not heard", () => {
    const quiet: NotificationSoundChoices = { ...CHOICES, friendOnline: "silent" };
    expect(soundForKind("friendOnline", quiet)).toBe("silent");
    expect(notificationTonePlan(soundForKind("friendOnline", quiet))).toBeNull();
  });
});
