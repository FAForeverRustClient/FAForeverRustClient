export interface MenuAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Place a menu beside its source, flipping or scrolling before covering it. */
export function menuPosition(
  point: { x: number; y: number },
  anchor: MenuAnchor | undefined,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const gap = 8;
  const maxHeight = Math.max(0, viewport.height - 2 * gap);
  const height = Math.min(menu.height, maxHeight);
  const clampX = (x: number) => Math.max(gap, Math.min(x, viewport.width - menu.width - gap));
  const clampY = (y: number) => Math.max(gap, Math.min(y, viewport.height - height - gap));
  if (anchor && anchor.bottom > anchor.top) {
    if (anchor.right + gap + menu.width <= viewport.width - gap) {
      return { x: anchor.right + gap, y: clampY(point.y), maxHeight };
    }
    if (anchor.left - gap - menu.width >= gap) {
      return { x: anchor.left - gap - menu.width, y: clampY(point.y), maxHeight };
    }
    const below = Math.max(0, viewport.height - anchor.bottom - 2 * gap);
    const above = Math.max(0, anchor.top - 2 * gap);
    if (below >= height || (below >= above && below > 0)) {
      return { x: clampX(point.x), y: anchor.bottom + gap, maxHeight: below };
    }
    if (above > 0) {
      const available = Math.min(height, above);
      return { x: clampX(point.x), y: anchor.top - gap - available, maxHeight: above };
    }
  }
  return { x: clampX(point.x + gap), y: clampY(point.y + gap), maxHeight };
}
