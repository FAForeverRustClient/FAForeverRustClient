// The authenticated application shell: persistent sidebar, tab bar, status bar,
// and the active tab's view. Routing is a pure lookup in the tab registry on nav
// state: no router. Theme selection now lives in the Settings tab.

import { Suspense, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { TabBar } from "../nav/TabBar";
import { TABS } from "../nav/tabs";
import { ClientStatusBar } from "../status/ClientStatusBar";
import { InstallBanner } from "./InstallBanner";
import { UpdateBanner } from "../updates/UpdateBanner";
import { BrandMark } from "../../design-system/BrandMark";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { PlayerCardModal } from "../player-card/PlayerCardModal";
import { ReviewsPanel } from "../reviews/ReviewsPanel";
import { UploadDialog } from "../uploads/UploadDialog";
import { openPlayerCard } from "../player-card/playerCardActions";
import { ReportPlayerModal } from "../reporting/ReportPlayerModal";
import { NotificationCenter } from "../notifications/NotificationCenter";
import { partyChatChannel } from "../lobby/partyChat";
import "./shell.css";

const SIDEBAR_DEFAULT_WIDTH = 224;
const SIDEBAR_MIN_WIDTH = 176;
const SIDEBAR_MAX_WIDTH = 400;

const clampSidebarWidth = (width: number) =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));

export function AppShell() {
  const activeTab = useAppStore((s) => s.state.nav.activeTab);
  const auth = useAppStore((s) => s.state.auth);
  const chatStatus = useAppStore((s) => s.state.chat.status);
  const party = useAppStore((s) => s.state.lobby.party);
  const player = auth.player;
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const joinedPartyChannelRef = useRef<string | null>(null);

  const logout = () => ipc.send({ kind: "Auth", command: { type: auth.mode === "test" ? "logoutTest" : "logout" } });
  const ActiveView = TABS[activeTab].Component;

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
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", stopResize);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", stopResize);
    };
  }, [isResizingSidebar]);

  const currentPartyChannel = partyChatChannel(party);
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
    setSidebarWidth((width) =>
      clampSidebarWidth(width + (event.key === "ArrowRight" ? 8 : -8)),
    );
  };

  const shellStyle = { "--sidebar-width": `${sidebarWidth}px` } as CSSProperties;

  return (
    <div className={`app-shell${isResizingSidebar ? " is-resizing-sidebar" : ""}`} style={shellStyle}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><BrandMark className="brand-mark-image" size={38} /></span>
          <span className="brand-copy">
            <strong>FAForever</strong>
            <small>Desktop client</small>
          </span>
        </div>

        <TabBar />

        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-profile-button"
            disabled={!player}
            onClick={() => player && void openPlayerCard(player.id, player.name)}
            aria-label={player ? `Open profile for ${player.name}` : "Player profile unavailable"}
          >
            <span className="profile-avatar" aria-hidden>{player?.name.charAt(0).toUpperCase() ?? "F"}</span>
            <span className="profile-copy">
              <span className="player-name">{player?.name ?? "Player"}</span>
              <span className="profile-status"><i /> Online</span>
            </span>
          </button>
          <NotificationCenter />
          <Button className="icon-button" onClick={logout} title="Log out" aria-label="Log out">
            <Icon name="logout" size={16} />
          </Button>
        </div>

        <div
          className="sidebar-resizer"
          role="separator"
          tabIndex={0}
          aria-label="Resize sidebar"
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
        </div>
        <section className="content" aria-label={`${TABS[activeTab].label} content`}>
          <div className={`content-inner content-${activeTab}`}>
            <Suspense fallback={<div className="muted" role="status">Loading section…</div>}>
              <ActiveView />
            </Suspense>
          </div>
        </section>

      </main>

      <ClientStatusBar />
      <PlayerCardModal />
      <ReviewsPanel />
      <UploadDialog />
      <ReportPlayerModal />
    </div>
  );
}
