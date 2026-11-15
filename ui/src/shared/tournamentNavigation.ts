// Draft presentation requests survive lazy mounting; selection stays in Rust.
let requested: { tournamentId: string; nonce: number } | null = null;
let next = 0;
const listeners = new Set<() => void>();

export function requestTournamentDraft(tournamentId: string) {
  requested = { tournamentId, nonce: ++next };
  for (const listener of listeners) listener();
}

export const pendingTournamentDraft = () => requested;
export function subscribeTournamentDraft(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function clearTournamentDraft(nonce: number) {
  if (requested?.nonce !== nonce) return;
  requested = null;
  for (const listener of listeners) listener();
}
