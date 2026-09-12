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
import { native } from "../../ipc/native";
import fafMatchUrl from "./assets/match-found.mp3";

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

/**
 * Every synthesised tone. `silent` has no plan, which is the point; `fafMatch`
 * is a file the client ships rather than notes to schedule; and a custom sound
 * is a file the player added.
 */
export type ToneSound = Exclude<NotificationSound, "silent" | SampleSound | { custom: string }>;

/**
 * The samples the client ships, mapped to the bundled file.
 *
 * One entry, and it is not a slippery slope: `fafMatch` is here because "a
 * match was found" is a sound people already know by ear from the Java client,
 * and no arrangement of sine partials is going to be that sound. Anything else
 * anybody wants is what the custom picker is for.
 */
export type SampleSound = "fafMatch";

const SAMPLES: Record<SampleSound, string> = {
  fafMatch: fafMatchUrl,
};

/** Whether a choice is one of the shipped samples. */
export function isSampleSound(sound: NotificationSound): sound is SampleSound {
  return typeof sound === "string" && sound in SAMPLES;
}

/** The stored file name, for a choice that is one; `null` for the five tones. */
export function customSoundName(sound: NotificationSound): string | null {
  return typeof sound === "object" && "custom" in sound ? sound.custom : null;
}

/** A choice as a value a `<select>` can hold and hand back. */
export function soundOptionValue(sound: NotificationSound): string {
  return typeof sound === "string" ? sound : `custom:${sound.custom}`;
}

/** The inverse of {@link soundOptionValue}. */
export function soundFromOptionValue(value: string): NotificationSound {
  return value.startsWith("custom:")
    ? { custom: value.slice("custom:".length) }
    : (value as NotificationSound);
}

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
const PLANS: Record<ToneSound, NotificationTonePlan> = {
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

/**
 * The plan for a shipped tone.
 *
 * `null` for the one that stays quiet, and also for a custom sound: that is a
 * file to decode rather than notes to schedule, and it is played by
 * {@link playNotificationSound} down a different path.
 */
export function notificationTonePlan(sound: NotificationSound): NotificationTonePlan | null {
  if (sound === "silent" || isSampleSound(sound) || customSoundName(sound) !== null) return null;
  return PLANS[sound as ToneSound];
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
  const custom = customSoundName(sound);
  if (custom !== null) {
    playFile(`custom:${custom}`, () => native.readNotificationSound(custom)
      .then((bytes) => new Uint8Array(bytes).buffer), volume);
    return;
  }
  if (isSampleSound(sound)) {
    playFile(`shipped:${sound}`, () => fetch(SAMPLES[sound]).then((r) => r.arrayBuffer()), volume);
    return;
  }
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


/**
 * Decoded sound files, by cache key.
 *
 * Decoding is the expensive half -- the bytes are read, crossed over the IPC
 * boundary or fetched, and turned into float samples -- and a notification
 * sound is played over and over, so it happens once per key per session. The
 * entry is the promise rather than the buffer, so two notifications arriving
 * together share one decode instead of racing two.
 *
 * A key that fails to load caches its failure as `null`. The alternative is
 * retrying a read of a file somebody deleted every time a friend comes online.
 *
 * Keys are prefixed (`custom:` / `shipped:`) so a player who names a file after
 * a shipped sample does not collide with it.
 */
const decoded = new Map<string, Promise<AudioBuffer | null>>();

/** Drop the cache, for when the set of stored sounds has changed. */
export function forgetCustomSounds() {
  decoded.clear();
}

function loadSound(
  context: AudioContext,
  key: string,
  read: () => Promise<ArrayBuffer>,
): Promise<AudioBuffer | null> {
  const existing = decoded.get(key);
  if (existing) return existing;

  // `decodeAudioData` detaches the buffer it is given, so every reader hands
  // over one it owns rather than a view onto something else.
  const loading = read()
    .then((bytes) => context.decodeAudioData(bytes))
    .catch(() => null);
  decoded.set(key, loading);
  return loading;
}

/**
 * Play a sound that is a file: one the client ships, or one the player added.
 *
 * Volume is applied the same way the tones apply it -- as a fraction of the
 * setting -- so moving the slider moves everything together. Unlike a tone,
 * the file's own level is whatever it was recorded at, so there is no peak
 * gain to scale: 100 means "as loud as the file is".
 *
 * Failure is silence. A sound that was deleted, or that turned out not to
 * decode, must not stop the notification it belongs to from appearing.
 */
function playFile(key: string, read: () => Promise<ArrayBuffer>, volume: number) {
  const level = Math.min(100, Math.max(0, volume)) / 100;
  if (level <= 0) return;
  const context = sharedContext();
  if (!context) return;

  const start = (buffer: AudioBuffer | null) => {
    if (!buffer) return;
    try {
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.setValueAtTime(level, context.currentTime);
      source.connect(gain);
      gain.connect(context.destination);
      source.start();
    } catch {
      // Same bargain as a tone: the notification is visible either way.
    }
  };

  const play = () => void loadSound(context, key, read).then(start, () => undefined);
  if (context.state === "running") {
    play();
    return;
  }
  void context.resume().then(play, () => undefined);
}
