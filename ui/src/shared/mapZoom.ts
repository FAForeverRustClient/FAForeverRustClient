/**
 * The pan and zoom of a map preview.
 *
 * Kept apart from the component because it is arithmetic with edges: a wheel
 * click has to keep the point under the cursor still, and a pan must never
 * expose the background behind the image. Both are easy to get subtly wrong
 * and neither needs a DOM to check.
 *
 * The image fills its viewport at scale 1 and is drawn with
 * `transform: translate(x, y) scale(s)` from the top-left corner, so the
 * content occupies `[x, x + s * width]`. Keeping the viewport covered is then
 * `width * (1 - s) <= x <= 0`, which at scale 1 leaves x pinned at 0.
 */
export interface ZoomTransform {
  scale: number;
  x: number;
  y: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

/// The whole map, centred, which is what the dialog opens on and what the
/// reset button goes back to.
export const NO_ZOOM: ZoomTransform = { scale: 1, x: 0, y: 0 };

export const MIN_SCALE = 1;
/// Six times is roughly one map cell filling the dialog on a 1024 preview.
/// Past that the image is its own compression artefacts.
export const MAX_SCALE = 6;

/// Clean discrete zoom increments for button and keyboard stepping.
export const ZOOM_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6] as const;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/// Push a transform back inside its viewport, so no edge of the image ever
/// leaves a gap.
export function clampPan(transform: ZoomTransform, size: ViewportSize): ZoomTransform {
  const minX = size.width * (1 - transform.scale);
  const minY = size.height * (1 - transform.scale);
  return {
    scale: transform.scale,
    x: Math.min(0, Math.max(minX, transform.x)),
    y: Math.min(0, Math.max(minY, transform.y)),
  };
}

/**
 * Zoom to `scale` while keeping `point`, in viewport coordinates, over the
 * same part of the map.
 *
 * That is the difference between a zoom that follows the cursor and one that
 * always pulls towards the middle: the content coordinate under the cursor is
 * `(point - offset) / scale`, and it is held fixed across the change.
 */
export function zoomTo(
  transform: ZoomTransform,
  scale: number,
  point: { x: number; y: number },
  size: ViewportSize,
): ZoomTransform {
  const next = clampScale(scale);
  const contentX = (point.x - transform.x) / transform.scale;
  const contentY = (point.y - transform.y) / transform.scale;
  return clampPan(
    { scale: next, x: point.x - contentX * next, y: point.y - contentY * next },
    size,
  );
}

/// Step to the next or previous preset zoom level. Stepping through explicit
/// presets keeps zoom levels round (100%, 125%, 150%, 200%, etc.) and fully
/// reversible across direction changes.
export function zoomByStep(
  transform: ZoomTransform,
  direction: 1 | -1,
  point: { x: number; y: number },
  size: ViewportSize,
): ZoomTransform {
  const current = transform.scale;
  let target: number;
  if (direction > 0) {
    const next = ZOOM_STEPS.find((s) => s > current + 0.01);
    target = next ?? MAX_SCALE;
  } else {
    const prev = [...ZOOM_STEPS].reverse().find((s) => s < current - 0.01);
    target = prev ?? MIN_SCALE;
  }
  return zoomTo(transform, target, point, size);
}

/// Zoom smoothly via wheel or trackpad delta. Dampened exponential scaling
/// prevents trackpad acceleration from shooting past bounds while keeping
/// standard mouse wheel ticks responsive.
export function zoomByWheel(
  transform: ZoomTransform,
  deltaY: number,
  point: { x: number; y: number },
  size: ViewportSize,
): ZoomTransform {
  const clamped = Math.max(-80, Math.min(80, deltaY));
  const factor = Math.exp(-clamped * 0.0025);
  let next = clampScale(transform.scale * factor);
  if (Math.abs(next - MIN_SCALE) < 0.02) {
    next = MIN_SCALE;
  }
  return zoomTo(transform, next, point, size);
}

/// Move the image by a mouse or keyboard delta, staying inside the viewport.
export function panBy(
  transform: ZoomTransform,
  delta: { x: number; y: number },
  size: ViewportSize,
): ZoomTransform {
  return clampPan(
    { scale: transform.scale, x: transform.x + delta.x, y: transform.y + delta.y },
    size,
  );
}
