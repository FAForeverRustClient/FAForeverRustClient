import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "home"
  | "news"
  | "chat"
  | "play"
  | "replays"
  | "maps"
  | "mods"
  | "leaderboard"
  | "trophy"
  | "book"
  | "units"
  | "changelog"
  | "github"
  | "settings"
  | "logout"
  | "arrowRight"
  | "chevronRight"
  | "chevronDown"
  | "chevronUp"
  | "activity"
  | "search"
  | "filter"
  | "users"
  | "lock"
  | "plus"
  | "refresh"
  | "list"
  | "grid"
  | "close"
  | "external"
  | "bell"
  | "eye"
  | "star"
  | "smile"
  | "calendar"
  // Wall-clock elapsed time: Java's `world-duration-icon`.
  | "clock"
  // Simulation time, which runs faster or slower than the clock: Java's
  // `game-duration-icon`. Distinct glyph on purpose: the two numbers sit next
  // to each other on a replay card and are routinely minutes apart.
  | "hourglass"
  | "upload"
  | "download"
  | "copy"
  | "edit"
  | "info"
  | "check";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5.5 9.5V21h13V9.5M9 21v-6h6v6" /></>,
    news: <><path d="M5 3h11a3 3 0 0 1 3 3v15H6a3 3 0 0 1-3-3V5" /><path d="M7 7h8M7 11h8M7 15h5" /></>,
    chat: <><path d="M20 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3Z" /><path d="M7 8h10M7 12h7" /></>,
    play: <><path d="m9 8 7 4-7 4Z" /><circle cx="12" cy="12" r="9" /></>,
    replays: <><path d="M4 12a8 8 0 1 0 2.34-5.66L4 8.68" /><path d="M4 4v4.68h4.68M10 8.5l5 3.5-5 3.5Z" /></>,
    maps: <><path d="m3 6 5-3 8 3 5-3v15l-5 3-8-3-5 3Z" /><path d="M8 3v15M16 6v15" /></>,
    mods: <><path d="M9 3v3a3 3 0 0 1-3 3H3v6h3a3 3 0 0 1 3 3v3h6v-3a3 3 0 0 1 3-3h3V9h-3a3 3 0 0 1-3-3V3Z" /></>,
    leaderboard: <><path d="M4 20V10h4v10M10 20V4h4v16M16 20v-7h4v7" /><path d="M2 20h20" /></>,
    book: <><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v16H6.5A2.5 2.5 0 0 0 4 20.5Z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v4H6.5A2.5 2.5 0 0 1 4 19.5" /></>,
    trophy: <><path d="M7 4h10v6a5 5 0 0 1-10 0Z" /><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3" /><path d="M12 15v4M9 21h6" /></>,
    units: <><path d="m12 2 8.5 5v10L12 22l-8.5-5V7Z" /><path d="m3.5 7 8.5 5 8.5-5M12 12v10" /></>,
    changelog: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M8 13h5M8 17h8" /></>,
    github: <><path d="M15 22v-3.3c0-1.1-.4-1.9-1-2.3 3.3-.4 6.7-1.6 6.7-7.1 0-1.6-.6-2.9-1.6-3.9.2-.4.7-1.9-.2-3.8 0 0-1.3-.4-4.1 1.5a14 14 0 0 0-7.5 0C4.5 1.2 3.2 1.6 3.2 1.6c-.9 1.9-.4 3.4-.2 3.8-1 1-1.6 2.3-1.6 3.9 0 5.5 3.4 6.7 6.7 7.1-.6.4-1 1.1-1 2.3V22" /><path d="M7.1 18.3c-3 .9-3-1.4-4.2-1.8" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.97 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.52-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10 3.05V3h4v.08a1.7 1.7 0 0 0 1.03 1.52 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.8 7l-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" /></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3" /><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" /></>,
    arrowRight: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    chevronRight: <path d="m9 18 6-6-6-6" />,
    chevronDown: <path d="m6 9 6 6 6-6" />,
    chevronUp: <path d="m6 15 6-6 6 6" />,
    activity: <path d="M3 12h4l2.5-7 5 14 2.5-7h4" />,
    search: <><circle cx="10" cy="10" r="6" /><path d="m14.5 14.5 5 5" /></>,
    filter: <path d="M4 6h16M7 12h10M10 18h4" />,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <><path d="M20 11a8 8 0 0 0-14.93-3M4 4v5h5" /><path d="M4 13a8 8 0 0 0 14.93 3M20 20v-5h-5" /></>,
    list: <><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z" />,
    smile: <><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><path d="M9 9.5h.01M15 9.5h.01" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5.2l3.4 2" /></>,
    hourglass: <><path d="M7 3h10M7 21h10" /><path d="M7 3v3.5c0 2 2.5 3.6 5 5.5 2.5-1.9 5-3.5 5-5.5V3" /><path d="M7 21v-3.5c0-2 2.5-3.6 5-5.5 2.5 1.9 5 3.5 5 5.5V21" /></>,
    upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="3" x2="12" y2="15" /></>,
    copy: <><rect width="13" height="13" x="9" y="9" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    edit: <><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></>,
    info: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="8" r=".8" fill="currentColor" stroke="none" /><path d="M12 11.5v4.5" /></>,
    check: <polyline points="20 6 9 17 4 12" />,
  };

  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
