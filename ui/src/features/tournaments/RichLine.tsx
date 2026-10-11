// A catalogue sentence with its `**bold**` and `[link]` marks drawn. See
// `richParts.ts` for why the marks live inside the translation.

import { richParts } from "./richParts";

export function RichLine({ text, onLink }: { text: string; onLink?: (index: number) => void }) {
  let links = 0;
  return (
    <>
      {richParts(text).map((part, index) => {
        if (part.kind === "strong") return <strong key={index}>{part.text}</strong>;
        if (part.kind === "link") {
          const which = links++;
          return (
            <button
              type="button"
              key={index}
              className="rich-text-link"
              onClick={() => onLink?.(which)}
            >
              {part.text}
            </button>
          );
        }
        return <span key={index}>{part.text}</span>;
      })}
    </>
  );
}
