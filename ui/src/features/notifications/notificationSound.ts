// The tones the client ships with.
//
// Synthesised, not sampled. Every plan below is a handful of sine partials and
// an envelope, which is why a set of "packaged sounds" costs no audio files, no
// decoder and no licence question. It also means a tone is data: a plan is a
// plain object, so the interesting half of this module is testable without an
// `AudioContext`, which `jsdom` does not have.
//
// The set is small on purpose and graded by how much attention it asks for.
// Everything used to play one tone, with a single "important" variant for a
// match and a party invite, and that is the complaint this answers: a friend
// coming online and a lobby filling up sounded identical.

import type {
  NotificationKind,
  NotificationSound,
  NotificationSoundChoices,
} from "../../ipc/bindings";

/** A harmonic above the note's own frequency. Shapes the timbre. */
export interface TonePartial {
  ratio: number;
  gain: number;
}

/** One note of a plan, positioned relative to the start of the sound. */
export interface ToneNote {
  frequency: number;
  startSeconds: number;
  durationSeconds: number;
}

export interface NotificationTonePlan {
  notes: readonly ToneNote[];
  attackSeconds: number;
  peakGain: number;
  partials: readonly TonePartial[];
}

/** Every tone that makes a sound. `silent` has no plan, which is the point. */
export type AudibleSound = Exclude<NotificationSound, "silent">;

const PARTIALS: readonly TonePartial[] = [
  { ratio: 1, gain: 1 },
  { ratio: 2, gain: 0.2 },
  { ratio: 3, gain: 0.06 },
];

/** A crisper timbre: one quiet octave instead of a stack. */
const BRIGHT_PARTIALS: readonly TonePartial[] = [
  { ratio: 1, gain: 1 },
  { ratio: 2, gain: 0.12 },
];

/**
 * The plans, quietest first.
 *
 * `alert` is two rising notes rather than one louder one: at these durations
 * pitch movement is what makes a sound recognisable across a room, and raising
 * the gain instead only makes it unpleasant.
 *
 * The gains are the levels the tones are actually heard at, and they were
 * wrong: every plan peaked around 0.04 of full scale, which is some 27 dB down,
 * and at the default volume of 70 a 200 ms blip that quiet is not a quiet
 * notification but an inaudible one. They were reported as silence. Each plan
 * now peaks between 0.12 and 0.3, roughly where the operating system's own
 * notifications sit, with the same spacing between the four as before. Still no
 * risk of clipping: the partials above the fundamental are quiet enough that a
 * rendered tone peaks at the plan's own gain.
 */
const PLANS: Record<AudibleSound, NotificationTonePlan> = {
  soft: {
    notes: [{ frequency: 392, startSeconds: 0, durationSeconds: 0.16 }],
    attackSeconds: 0.02,
    peakGain: 0.12,
    partials: PARTIALS,
  },
  chime: {
    notes: [{ frequency: 523.25, startSeconds: 0, durationSeconds: 0.2 }],
    attackSeconds: 0.014,
    peakGain: 0.22,
    partials: PARTIALS,
  },
  ping: {
    notes: [{ frequency: 880, startSeconds: 0, durationSeconds: 0.12 }],
    attackSeconds: 0.008,
    peakGain: 0.18,
    partials: BRIGHT_PARTIALS,
  },
  alert: {
    notes: [
      { frequency: 659.25, startSeconds: 0, durationSeconds: 0.14 },
      { frequency: 987.77, startSeconds: 0.13, durationSeconds: 0.22 },
    ],
    attackSeconds: 0.012,
    peakGain: 0.3,
    partials: PARTIALS,
  },
};

/** The plan for a tone, or `null` for the one that stays quiet. */
export function notificationTonePlan(sound: NotificationSound): NotificationTonePlan | null {
  return sound === "silent" ? null : PLANS[sound];
}

/** How long a plan runs, for tests and for closing the audio context. */
export function tonePlanDuration(plan: NotificationTonePlan): number {
  return Math.max(...plan.notes.map((note) => note.startSeconds + note.durationSeconds));
}

/**
 * Which tone a notification plays.
 *
 * One case per switch in the notification settings, so the dropdown a player
 * sets sits in the same row as the switch that turns the notification on.
 * Everything without a switch of its own falls to `other`: server notices,
 * errors, a finished map, a new client version, and the rest.
 */
export function soundForKind(
  kind: NotificationKind,
  choices: NotificationSoundChoices,
): NotificationSound {
  switch (kind) {
    case "matchFound": return choices.matchFound;
    case "privateMessage": return choices.privateMessage;
    case "mention": return choices.mention;
    case "friendOnline": return choices.friendOnline;
    case "friendOffline": return choices.friendOffline;
    case "friendPlaying": return choices.friendPlaying;
    case "newCustomGame": return choices.newCustomGame;
    case "gameFull": return choices.gameFull;
    case "gameLaunched": return choices.gameLaunched;
    case "reviewReminder": return choices.reviewReminder;
    case "partyInvite": return choices.partyInvite;
    default: return choices.other;
  }
}

/** How much of full scale a tone peaks at, for a given volume setting. */
export function tonePeakGain(plan: NotificationTonePlan, volume: number): number {
  return (plan.peakGain * Math.min(100, Math.max(0, volume))) / 100;
}

/**
 * The one audio context this module ever opens.
 *
 * One, not one per tone, and it is never closed. A fresh context has to open
 * the output device before it can play anything, which on Windows takes long
 * enough to swallow a 200 ms tone whole: the notes were scheduled against a
 * `currentTime` the device had not reached yet, so the envelope had already run
 * its course by the time there was anywhere to send it. Reusing a running
 * context costs that wait once, on the first sound of the session.
 *
 * A context with nothing referencing it is also a context the browser may
 * collect mid-tone, and Chromium limits how many a document can hold at once,
 * which a settings page somebody is clicking through would reach.
 */
let shared: AudioContext | null = null;

function sharedContext(): AudioContext | null {
  try {
    if (!shared || shared.state === "closed") {
      shared = new AudioContext();
    }
    return shared;
  } catch {
    // No audio device, or no Web Audio at all (`jsdom` in the tests).
    return null;
  }
}

/** Put one plan's notes on the timeline, starting at `origin`. */
function scheduleTone(
  context: AudioContext,
  plan: NotificationTonePlan,
  peak: number,
  origin: number,
) {
  for (const note of plan.notes) {
    const start = origin + note.startSeconds;
    const end = start + note.durationSeconds;
    const master = context.createGain();
    // Exponential ramps, because a linear fade on a tone this short is heard
    // as a click at both ends. They cannot reach zero, hence 0.0001.
    master.gain.setValueAtTime(0.0001, start);
    master.gain.exponentialRampToValueAtTime(peak, start + plan.attackSeconds);
    master.gain.exponentialRampToValueAtTime(0.0001, end);
    master.connect(context.destination);

    for (const partial of plan.partials) {
      const oscillator = context.createOscillator();
      const partialGain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(note.frequency * partial.ratio, start);
      partialGain.gain.setValueAtTime(partial.gain, start);
      oscillator.connect(partialGain);
      partialGain.connect(master);
      oscillator.start(start);
      oscillator.stop(end);
      // The nodes are disconnected by the engine once the oscillator has
      // finished, and the context they hang off is the shared one, so there is
      // nothing left to tear down by hand.
    }
  }
}

/**
 * How far ahead of the clock a tone is scheduled.
 *
 * Zero lead means the first ramp point is the current instant, which one audio
 * callback later is the past: the envelope then starts part way down and the
 * attack is heard as a click, or not at all. 20 ms is inaudible as a delay and
 * longer than a callback.
 */
const SCHEDULE_LEAD_SECONDS = 0.02;

/**
 * Play one tone.
 *
 * A no-op for `silent`, for volume 0, and for any environment without working
 * audio: the notification is visible either way, and a client that throws
 * because a machine has no sound card would be worse than a quiet one.
 *
 * A suspended context is resumed first and the notes go on the timeline only
 * once it is running. Scheduling into a suspended context and resuming it
 * afterwards puts the whole envelope behind the clock, which is silence.
 */
export function playNotificationSound(sound: NotificationSound, volume: number) {
  const plan = notificationTonePlan(sound);
  if (!plan) return;
  const peak = tonePeakGain(plan, volume);
  if (peak <= 0) return;

  const context = sharedContext();
  if (!context) return;

  const play = () => {
    try {
      scheduleTone(context, plan, peak, context.currentTime + SCHEDULE_LEAD_SECONDS);
    } catch {
      // The visible notification remains available when audio is unavailable.
    }
  };

  if (context.state === "running") {
    play();
    return;
  }
  // Autoplay policy: the context starts suspended until the document has been
  // interacted with. Every caller here is either a click or a keypress in the
  // settings, or a notification arriving in a window somebody has already used,
  // so this resolves; if it does not, the tone is dropped rather than queued.
  void context.resume().then(play, () => undefined);
}
