// The night sky behind the Galactic War tab: a field of stars, denser along
// one band the way the Milky Way is, with a few bright ones that glow.
//
// Drawn from a fixed seed, so it is the same sky every time the tab opens
// and never flickers on a re-render; computed once per session, not per
// render. The faction is not in it: the stars are white (the text colour),
// and the faction's colour comes from the nebula the stylesheet paints
// behind them.

import { memo } from "react";

/** The canvas the stars are placed on; the SVG scales it to cover the tab. */
const WIDTH = 1600;
const HEIGHT = 1000;
const SEED = 0x6a1ac71c;

interface Star {
  x: number;
  y: number;
  r: number;
  opacity: number;
}

/** A small, fast, seeded generator (mulberry32): the same sky every time. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A roughly normal offset, for stars that crowd towards the band. */
function gaussian(next: () => number): number {
  return (next() + next() + next() + next() - 2) / 2;
}

function makeSky(): { faint: Star[]; bright: Star[] } {
  const next = random(SEED);
  const faint: Star[] = [];
  // Scattered across the whole sky.
  for (let i = 0; i < 260; i++) {
    faint.push({
      x: next() * WIDTH,
      y: next() * HEIGHT,
      r: 0.5 + next() * 0.8,
      opacity: 0.3 + next() * 0.5,
    });
  }
  // Crowding along a band from the lower left to the upper right.
  for (let i = 0; i < 220; i++) {
    const along = next();
    const across = gaussian(next) * 130;
    faint.push({
      x: along * WIDTH + across * 0.35,
      y: HEIGHT * 0.88 - along * HEIGHT * 0.7 + across,
      r: 0.45 + next() * 0.7,
      opacity: 0.25 + next() * 0.45,
    });
  }
  const bright: Star[] = [];
  for (let i = 0; i < 18; i++) {
    bright.push({
      x: next() * WIDTH,
      y: next() * HEIGHT,
      r: 1.1 + next() * 0.9,
      opacity: 0.7 + next() * 0.3,
    });
  }
  return { faint, bright };
}

const SKY = makeSky();

export const GalacticWarStarfield = memo(function GalacticWarStarfield() {
  return (
    <svg
      className="gw-starfield"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <g fill="currentColor">
        {SKY.faint.map((star, index) => (
          <circle key={index} cx={star.x.toFixed(1)} cy={star.y.toFixed(1)} r={star.r.toFixed(2)} opacity={star.opacity.toFixed(2)} />
        ))}
      </g>
      {/* The bright ones: a soft halo under a sharp point. */}
      <g fill="currentColor">
        {SKY.bright.map((star, index) => (
          <g key={index}>
            <circle cx={star.x.toFixed(1)} cy={star.y.toFixed(1)} r={(star.r * 4).toFixed(2)} opacity={(star.opacity * 0.09).toFixed(3)} />
            <circle cx={star.x.toFixed(1)} cy={star.y.toFixed(1)} r={(star.r * 2).toFixed(2)} opacity={(star.opacity * 0.16).toFixed(3)} />
            <circle cx={star.x.toFixed(1)} cy={star.y.toFixed(1)} r={star.r.toFixed(2)} opacity={star.opacity.toFixed(2)} />
          </g>
        ))}
      </g>
    </svg>
  );
});
