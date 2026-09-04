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
import { TABS } from "../nav/tabs";
import { ClientStatusBar } from "../status/ClientStatusBar";
import { InstallBanner } from "./InstallBanner";
import { WebviewEngineBanner } from "./WebviewEngineBanner";
import { UpdateBanner } from "../updates/UpdateBanner";
import { BrandMark } from "../../design-system/BrandMark";
import { PlayerCardModal } from "../player-card/PlayerCardModal";
import { ReviewsPanel } from "../reviews/ReviewsPanel";
import { ModReplacementDialog } from "../lobby/ModReplacementDialog";
import { UploadDialog } from "../uploads/UploadDialog";
import { openPlayerCard } from "../player-card/playerCardActions";
import { useTranslation } from "../../i18n/useTranslation";
import { ReportPlayerModal } from "../reporting/ReportPlayerModal";
import { NotificationCenter } from "../notifications/NotificationCenter";
import { partyChatChannel } from "../lobby/partyChat";
import { PlayerName } from "../../shared/nameColors";
import "./shell.css";

const SIDEBAR_DEFAULT_WIDTH = 224;
const SIDEBAR_MIN_WIDTH = 176;
const SIDEBAR_MAX_WIDTH = 400;

const clampSidebarWidth = (width: number) =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));

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
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const joinedPartyChannelRef = useRef<string | null>(null);
  const contentRef = useRef<HTMLElement>(null);

  const ActiveView = TABS[activeTab].Component;

  // The scroll container outlives the view inside it: only the class and the
  // children change on a tab switch, so the previous tab's scroll position was
  // still there and a tab opened halfway down. Before paint, so the new tab is
  // never seen scrolled. Tabs that scroll internally are unaffected, their own
  // container unmounts with the view.
  useLayoutEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [activeTab]);

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
    setSidebarWidth((width) =>
      clampSidebarWidth(width + (event.key === "ArrowRight" ? 8 : -8)),
    );
  };

  const shellStyle = { "--sidebar-width": `${sidebarWidth}px` } as CSSProperties;

  return (
    <div className={`app-shell${isResizingSidebar ? " is-resizing-sidebar" : ""}`} style={shellStyle}>
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
              <span className="player-name">{player ? <PlayerName name={player.name} /> : t("shell.sidebar.player")}</span>
              <span className="profile-status"><i /> {t("shell.sidebar.online")}</span>
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
          className={`content content-tab-${activeTab}`}
          aria-label={t("nav.content.aria", { tab: t(TABS[activeTab].label) })}
        >
          <div className={`content-inner content-${activeTab}`}>
            <Suspense fallback={<div className="muted" role="status">{t("shell.loadingSection")}</div>}>
              <ActiveView />
            </Suspense>
          </div>
        </section>

      </main>

      <ClientStatusBar />
      <ModReplacementDialog />
      <PlayerCardModal />
      <ReviewsPanel />
      <UploadDialog />
      <ReportPlayerModal />
    </div>
  );
}
