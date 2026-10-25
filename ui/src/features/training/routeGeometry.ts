/** Preserve every leg while keeping the SVG node count independent of samples. */
export function routeGeometry(points: readonly { x: number; z: number; reclaim: boolean }[]) {
  const parts = [[], []] as [string[], string[]];
  let previousKind = -1;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const kind = a.reclaim && b.reclaim ? 1 : 0;
    if (kind !== previousKind) parts[kind].push(`M${a.x},${a.z}`);
    parts[kind].push(`L${b.x},${b.z}`);
    previousKind = kind;
  }
  return {
    routePoints: points.map((point) => `${point.x},${point.z}`).join(" "),
    travel: parts[0].join(""),
    reclaim: parts[1].join(""),
  };
}
