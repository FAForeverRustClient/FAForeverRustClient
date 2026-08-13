export type NotificationTonePlan = {
  frequency: number;
  attackSeconds: number;
  durationSeconds: number;
  peakGain: number;
  partials: readonly { ratio: number; gain: number }[];
};

const PARTIALS = [
  { ratio: 1, gain: 1 },
  { ratio: 2, gain: 0.2 },
  { ratio: 3, gain: 0.06 },
] as const;

export function notificationTonePlan(important: boolean): NotificationTonePlan {
  return {
    frequency: important ? 659.25 : 523.25,
    attackSeconds: 0.014,
    durationSeconds: important ? 0.24 : 0.2,
    peakGain: important ? 0.075 : 0.06,
    partials: PARTIALS,
  };
}

export function playNotificationAlert(volume: number, important: boolean) {
  const normalizedVolume = Math.min(100, Math.max(0, volume));
  if (normalizedVolume === 0) return;

  let context: AudioContext | undefined;
  try {
    const audioContext = new AudioContext();
    context = audioContext;
    const tone = notificationTonePlan(important);
    const start = audioContext.currentTime;
    const end = start + tone.durationSeconds;
    const master = audioContext.createGain();
    const peak = tone.peakGain * normalizedVolume / 100;

    master.gain.setValueAtTime(0.0001, start);
    master.gain.exponentialRampToValueAtTime(peak, start + tone.attackSeconds);
    master.gain.exponentialRampToValueAtTime(0.0001, end);
    master.connect(audioContext.destination);

    tone.partials.forEach((partial, index) => {
      const oscillator = audioContext.createOscillator();
      const partialGain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(tone.frequency * partial.ratio, start);
      partialGain.gain.setValueAtTime(partial.gain, start);
      oscillator.connect(partialGain);
      partialGain.connect(master);
      oscillator.start(start);
      oscillator.stop(end);

      if (index === tone.partials.length - 1) {
        oscillator.addEventListener("ended", () => {
          void audioContext.close().catch(() => undefined);
        });
      }
    });

    void audioContext.resume().catch(() => undefined);
  } catch {
    void context?.close().catch(() => undefined);
    // The visible notification remains available when audio is unavailable.
  }
}
