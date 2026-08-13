// Units tab — embeds the community ETFreeman unit database directly
// (https://faforever.github.io/etfreeman-db/#/) rather than reimplementing
// its UI: it already has every feature (search, filters, comparisons,
// weapon/projectile detail) and matching its visual polish exactly is only
// achievable by using the real thing. No custom parsing/state on our side —
// this tab is presentation-only, an `<iframe>` and nothing else.

const ETFREEMAN_URL = "https://faforever.github.io/etfreeman-db/#/";

export function UnitsView() {
  return (
    <div className="units-embed">
      <iframe
        className="units-embed-frame"
        src={ETFREEMAN_URL}
        title="ETFreeman Unit Database"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
