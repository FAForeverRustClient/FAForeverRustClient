import { memo, useMemo, type CSSProperties, type ReactNode } from "react";
import { useAppStore } from "../store/store";
import { assignedPlayerColor, includesName, nickHue } from "./nameColorsUtil";

export {
  DEFAULT_COLOR_PICKER_VALUE,
  STANDARD_CATEGORY_COLORS,
  assignedPlayerColor,
  includesName,
  nickHue,
  nickKey,
  nickStyle,
  playerColorLookup,
  resolvePlayerStyle,
} from "./nameColorsUtil";
export type { CategoryColorKey } from "./nameColorsUtil";

/**
 * React hook resolving styling for a player nickname. Granularly selects only
 * the computed color string to avoid re-rendering whenever unrelated player
 * directory updates occur in the background.
 */
export function usePlayerStyle(name: string): CSSProperties | undefined {
  const color = useAppStore((state) => {
    if (!name) return undefined;
    const chat = state.state.settings.chat;
    const assignedColor = assignedPlayerColor(chat.nameColors.players, name);
    if (assignedColor) return assignedColor;

    if (chat.nameColors.friends && includesName(state.state.social.friends, name)) {
      return chat.nameColors.friends;
    }

    if (chat.nameColors.foes && includesName(state.state.social.foes, name)) {
      return chat.nameColors.foes;
    }

    if (chat.coloredNames) {
      return `hsl(${nickHue(name)}, 75%, 65%)`;
    }

    return undefined;
  });

  return useMemo(() => (color ? { color } : undefined), [color]);
}

/**
 * Shared component to render a player's username with friend/foe/custom coloring.
 */
export const PlayerName = memo(function PlayerName({
  name,
  className,
  style,
  title,
  children,
}: {
  name: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  children?: ReactNode;
}) {
  const colorStyle = usePlayerStyle(name);
  return (
    <span
      className={className}
      title={title ?? name}
      style={colorStyle ? { ...colorStyle, ...style } : style}
    >
      {children ?? name}
    </span>
  );
});
