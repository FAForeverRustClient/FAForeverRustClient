const EDITABLE_SELECTOR = [
  "textarea",
  "input:not([type])",
  'input[type="text"]',
  'input[type="search"]',
  'input[type="email"]',
  'input[type="password"]',
  'input[type="url"]',
  'input[type="tel"]',
  'input[type="number"]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
].join(",");

interface ClosestTarget {
  closest: (selector: string) => unknown;
}

function hasClosest(target: EventTarget | null): target is EventTarget & ClosestTarget {
  return typeof (target as Partial<ClosestTarget> | null)?.closest === "function";
}

export function allowsEditingContextMenu(target: EventTarget | null): boolean {
  return hasClosest(target) && target.closest(EDITABLE_SELECTOR) !== null;
}

export function applyDesktopContextMenuPolicy(
  event: Pick<MouseEvent, "target" | "preventDefault">,
): void {
  if (!allowsEditingContextMenu(event.target)) {
    event.preventDefault();
  }
}

export function installDesktopContextMenuPolicy(documentRoot: Document): () => void {
  documentRoot.addEventListener("contextmenu", applyDesktopContextMenuPolicy, true);
  return () => documentRoot.removeEventListener("contextmenu", applyDesktopContextMenuPolicy, true);
}
