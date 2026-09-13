// The authenticated application shell: persistent sidebar, tab bar, status bar,
// and the active tab's view. Routing is a pure lookup in the tab registry on nav
// state: no router. Theme selection now lives in the Settings tab.

import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { ipc } from "../../ipc/client";
import { findPlayer } from "../../store/reducer";
import { useAppStore } from "../../store/store";
import { ProfileAvatar } from "../../shared/ProfileAvatar";
import { TabBar } from "../nav/TabBar";
import { openTabForMode, TABS } from "../nav/tabs";
import { ClientStatusBar } from "../status/ClientStatusBar";
import { InstallBanner } from "./InstallBanner";
import { WebviewEngineBanner } from "./WebviewEngineBanner";
import { UpdateBanner } from "../updates/UpdateBanner";
import { UpdateGate } from "../updates/UpdateGate";
import { BrandMark } from "../../design-system/BrandMark";
import { PlayerCardModal } from "../player-card/PlayerCardModal";
import { ReviewsPanel } from "../reviews/ReviewsPanel";
import { JoinDownloadDialog } from "../lobby/JoinDownloadDialog";
import { JoinPreparationDialog } from "../lobby/JoinPreparationDialog";
import { ModReplacementDialog } from "../lobby/ModReplacementDialog";
import { UploadDialog } from "../uploads/UploadDialog";
import { openPlayerCard } from "../player-card/playerCardActions";
import { useTranslation } from "../../i18n/useTranslation";
import { ReportPlayerModal } from "../reporting/ReportPlayerModal";
import { NotificationCenter } from "../notifications/NotificationCenter";
import { partyChatChannel } from "../lobby/partyChat";
import { PlayerName } from "../../shared/nameColors";
import "./shell.css";

// Mirrors `MIN_SIDEBAR_WIDTH` / `MAX_SIDEBAR_WIDTH` / `SIDEBAR_RAIL_BELOW` in
// faf-domain, which clamps the same value on the way in from the settings file.
const SIDEBAR_MIN_WIDTH = 64;
const SIDEBAR_MAX_WIDTH = 400;
/// Narrower than this and the labels come off, leaving the icon rail the shell
/// already draws for a narrow window.
const SIDEBAR_RAIL_BELOW = 150;

const clampSidebarWidth = (width: number) =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));

/**
 * Write the width back, once a drag has stopped rather than on every frame.
 *
 * Reads the newest copy of the block because `setAppearance` replaces the whole
 * thing, and a drag that started before some other setting changed would
 * otherwise write that other setting back to its old value.
 */
function persistSidebarWidth(width: number) {
  const current = useAppStore.getState().state.settings.appearance;
  if (current.sidebarWidth === width) return;
  ipc.send({
    kind: "Settings",
    command: { type: "setAppearance", payload: { preferences: { ...current, sidebarWidth: width } } },
  });
}

export function AppShell() {
  const { t } = useTranslation();
  const activeTab = useAppStore((s) => s.state.nav.activeTab);
  const auth = useAppStore((s) => s.state.auth);
  const chatStatus = useAppStore((s) => s.state.chat.status);
  const party = useAppStore((s) => s.state.lobby.party);
  // The party message carries ids, not names: the room name needs the owner's
  // real login, which only the live directory has. See `partyChatChannel`.
  const social = useAppStore((s) => s.state.social);
  const player = auth.player;
  // The signed-in account's own entry in the live player directory, which is
  // where the avatar the lobby knows about lives.
  const ownProfile = player ? findPlayer(social, player.name) : null;
  // Seeded from the persisted value and written back when a drag ends: the
  // window's own geometry has been remembered for a while, and the panel inside
  // it going back to 224 px on every start was the odd one out.
  const appearance = useAppStore((s) => s.state.settings.appearance);
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebarWidth(appearance.sidebarWidth));
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const joinedPartyChannelRef = useRef<string | null>(null);
  const contentRef = useRef<HTMLElement>(null);

  const openTab = openTabForMode(auth.mode, activeTab);
  const ActiveView = TABS[openTab].Component;

  // The scroll container outlives the view inside it: only the class and the
  // children change on a tab switch, so the previous tab's scroll position was
  // still there and a tab opened halfway down. Before paint, so the new tab is
  // never seen scrolled. Tabs that scroll internally are unaffected, their own
  // container unmounts with the view.
  useLayoutEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [openTab]);

  // Changed in Settings rather than by dragging: the state below is seeded
  // once, so without this the segmented control in Appearance would write a
  // width the shell never read back.
  useEffect(() => {
    setSidebarWidth((current) =>
      current === appearance.sidebarWidth ? current : clampSidebarWidth(appearance.sidebarWidth),
    );
  }, [appearance.sidebarWidth]);

  useEffect(() => {
    if (!isResizingSidebar) return;

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      setSidebarWidth(clampSidebarWidth(resize.startWidth + event.clientX - resize.startX));
    };
    const stopResize = () => {
      resizeRef.current = null;
      setIsResizingSidebar(false);
      // At the end of the drag, not on every mousemove: a drag is a hundred
      // widths and one decision.
      setSidebarWidth((width) => {
        persistSidebarWidth(width);
        return width;
      });
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", stopResize);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", stopResize);
    };
  }, [isResizingSidebar]);

  const currentPartyChannel = partyChatChannel(party, social, player);
  useEffect(() => {
    // Match the Java/Python lifecycle: changing leaders parts the old room and
    // joins the new one; dissolving/leaving a party only parts. Resetting the
    // ref while offline ensures reconnecting joins the current party again.
    if (chatStatus !== "connected") {
      joinedPartyChannelRef.current = null;
      return;
    }

    const previous = joinedPartyChannelRef.current;
    if (previous && previous !== currentPartyChannel) {
      ipc.send({ kind: "Chat", command: { type: "leaveChannel", payload: { channel: previous } } });
    }
    if (currentPartyChannel && previous !== currentPartyChannel) {
      ipc.send({ kind: "Chat", command: { type: "joinChannel", payload: { channel: currentPartyChannel } } });
    }
    joinedPartyChannelRef.current = currentPartyChannel;
  }, [chatStatus, currentPartyChannel]);

  const handleSidebarMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    setIsResizingSidebar(true);
  };

  const handleSidebarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setSidebarWidth((width) => {
      const next = clampSidebarWidth(width + (event.key === "ArrowRight" ? 8 : -8));
      persistSidebarWidth(next);
      return next;
    });
  };

  // Everything the client tints "because a friend is involved" reads this one
  // token, and the colour it holds is the one the reader chose for friends in
  // chat. A second, fixed green for the same idea elsewhere in the client was
  // a setting that only half applied.
  const friendColor = useAppStore((state) => state.state.settings.chat.nameColors.friends);
  const shellStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    ...(friendColor ? { "--color-friend": friendColor } : {}),
  } as CSSProperties;

  return (
    <div
      className={[
        "app-shell",
        isResizingSidebar && "is-resizing-sidebar",
        sidebarWidth < SIDEBAR_RAIL_BELOW && "is-sidebar-rail",
      ].filter(Boolean).join(" ")}
      style={shellStyle}
    >
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><BrandMark size={38} /></span>
          <span className="brand-copy">
            <strong>FAForever</strong>
            <small>{t("shell.sidebar.desktopClient")}</small>
          </span>
        </div>

        <TabBar />

        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-profile-button"
            disabled={!player}
            onClick={() => player && void openPlayerCard(player.id, player.name)}
            aria-label={player ? t("shell.sidebar.openProfile", { name: player.name }) : t("shell.sidebar.profileUnavailable")}
          >
            <ProfileAvatar
              name={player?.name ?? "F"}
              avatarUrl={ownProfile?.avatarUrl}
              tooltip={ownProfile?.avatarTooltip}
            />
            <span className="profile-copy">
              <span className="player-name">
                {player
                  ? <PlayerName name={player.name} />
                  : t(auth.mode === "offline" ? "shell.sidebar.noAccount" : "shell.sidebar.player")}
              </span>
              <span className="profile-status">
                <i /> {t(auth.mode === "offline" ? "shell.sidebar.offline" : "shell.sidebar.online")}
              </span>
            </span>
          </button>
          <NotificationCenter />
        </div>

        <div
          className="sidebar-resizer"
          role="separator"
          tabIndex={0}
          aria-label={t("shell.sidebar.resize")}
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          onKeyDown={handleSidebarKeyDown}
          onMouseDown={handleSidebarMouseDown}
        />
      </aside>

      <main className="workspace">
        {/* One row, however many banners are up: both used to claim grid row 1
            and would have overlapped the moment an update landed on a client
            with no game install configured. */}
        <div className="workspace-banners">
          <UpdateBanner />
          <InstallBanner />
          <WebviewEngineBanner />
        </div>
        <section
          ref={contentRef}
          className={`content content-tab-${openTab}`}
          aria-label={t("nav.content.aria", { tab: t(TABS[openTab].label) })}
        >
          <div className={`content-inner content-${openTab}`}>
            <Suspense fallback={<div className="muted" role="status">{t("shell.loadingSection")}</div>}>
              <ActiveView />
            </Suspense>
          </div>
        </section>

      </main>

      {/* Last, and outside the banner row: this one is a dialog over the
          whole client rather than a strip inside it. */}
      <UpdateGate />
      <ClientStatusBar />
      <ModReplacementDialog />
      <JoinDownloadDialog />
      <JoinPreparationDialog />
      <PlayerCardModal />
      <ReviewsPanel />
      <UploadDialog />
      <ReportPlayerModal />
    </div>
  );
}
