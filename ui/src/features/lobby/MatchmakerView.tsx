// Matchmaker subtab — placeholder. Ladder queues use an entirely different
// protocol surface (queue joining, party invites, a matchmaker state machine)
// that hasn't been researched yet; see the Play tab overhaul plan for the
// follow-up scoping this needs before it can be built for real.

export function MatchmakerView() {
  return (
    <div className="placeholder">
      <p className="muted">
        Coming soon — ladder queues need their own protocol research pass before this can be built.
      </p>
    </div>
  );
}
