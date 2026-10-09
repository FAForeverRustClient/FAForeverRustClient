// Empty cells that hold a short page of a card grid at the height of a full
// one, so the pager under the grid stays where the full pages put it. How
// many is `pageFillerCount`'s answer.
//
// Each cell carries the real card's classes, so it is exactly a card's size,
// and is then hidden: not drawn, not hit by the pointer, not in the
// accessibility tree, and never focusable.

export function GridPageFiller({ count, cardClassName }: { count: number; cardClassName: string }) {
  if (count <= 0) return null;
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={`${cardClassName} grid-page-filler`} aria-hidden="true" />
      ))}
    </>
  );
}
