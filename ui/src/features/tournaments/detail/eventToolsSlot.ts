// Where the open event's display switches are drawn: a slot at the far end of
// the site's tab row, held by the view. The switches' state belongs to the
// detail pane, which portals them into the slot, so they leave with the event.

import { createContext } from "react";

export const EventToolsSlot = createContext<HTMLElement | null>(null);
