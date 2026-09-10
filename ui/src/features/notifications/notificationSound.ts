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
 * `chime` is the tone the client already played, unchanged, so choosing it
 * everywhere restores exactly the old behaviour. `alert` is two rising notes
 * rather than one louder one: at these durations pitch movement is what makes
 * a sound recognisable across a room, and raising the gain instead only makes
 * it unpleasant.
 */
const PLANS: Record<AudibleSound, NotificationTonePlan> = {
  soft: {
    notes: [{ frequency: 392, startSeconds: 0, durationSeconds: 0.16 }],
    attackSeconds: 0.02,
    peakGain: 0.035,
    partials: PARTIALS,
  },
  chime: {
    notes: [{ frequency: 523.25, startSeconds: 0, durationSeconds: 0.2 }],
    attackSeconds: 0.014,
    peakGain: 0.06,
    partials: PARTIALS,
  },
  ping: {
    notes: [{ frequency: 880, startSeconds: 0, durationSeconds: 0.12 }],
    attackSeconds: 0.008,
    peakGain: 0.06,
    partials: BRIGHT_PARTIALS,
  },
  alert: {
    notes: [
      { frequency: 659.25, startSeconds: 0, durationSeconds: 0.14 },
      { frequency: 987.77, startSeconds: 0.13, durationSeconds: 0.22 },
    ],
    attackSeconds: 0.012,
    peakGain: 0.08,
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

/**
 * Play one tone.
 *
 * A no-op for `silent`, for volume 0, and for any environment without working
 * audio: the notification is visible either way, and a client that throws
 * because a machine has no sound card would be worse than a quiet one.
 */
export function playNotificationSound(sound: NotificationSound, volume: number) {
  const plan = notificationTonePlan(sound);
  if (!plan) return;
  const normalizedVolume = Math.min(100, Math.max(0, volume));
  if (normalizedVolume === 0) return;

  let context: AudioContext | undefined;
  try {
    const audioContext = new AudioContext();
    context = audioContext;
    const origin = audioContext.currentTime;
    const peak = (plan.peakGain * normalizedVolume) / 100;
    const oscillators: OscillatorNode[] = [];

    for (const note of plan.notes) {
      const start = origin + note.startSeconds;
      const end = start + note.durationSeconds;
      const master = audioContext.createGain();
      // Exponential ramps, because a linear fade on a tone this short is heard
      // as a click at both ends. They cannot reach zero, hence 0.0001.
      master.gain.setValueAtTime(0.0001, start);
      master.gain.exponentialRampToValueAtTime(peak, start + plan.attackSeconds);
      master.gain.exponentialRampToValueAtTime(0.0001, end);
      master.connect(audioContext.destination);

      for (const partial of plan.partials) {
        const oscillator = audioContext.createOscillator();
        const partialGain = audioContext.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(note.frequency * partial.ratio, start);
        partialGain.gain.setValueAtTime(partial.gain, start);
        oscillator.connect(partialGain);
        partialGain.connect(master);
        oscillator.start(start);
        oscillator.stop(end);
        oscillators.push(oscillator);
      }
    }

    // Close on the last oscillator to finish, not the last one created: a plan
    // whose notes overlap does not schedule them in ending order.
    const last = oscillators[oscillators.length - 1];
    last?.addEventListener("ended", () => {
      void audioContext.close().catch(() => undefined);
    });

    void audioContext.resume().catch(() => undefined);
  } catch {
    void context?.close().catch(() => undefined);
    // The visible notification remains available when audio is unavailable.
  }
}
