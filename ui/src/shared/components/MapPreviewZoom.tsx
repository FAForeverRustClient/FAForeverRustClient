import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { MapPreview, type PreviewableMap } from "./MapPreview";
import { toggleFavoriteMap, useIsFavoriteMap } from "../favoriteMaps";
import { requestMapVaultFocus } from "../mapVaultFocus";
import { isGeneratedMap } from "../mapPresentation";
import { Button } from "../../design-system/Button";
import "./map-preview-zoom.css";
import {
  MAX_SCALE,
  MIN_SCALE,
  NO_ZOOM,
  panBy,
  zoomByStep,
  zoomByWheel,
  zoomTo,
  type ZoomTransform,
} from "../mapZoom";

/// How far an arrow key moves the view, in viewport pixels. A pan the keyboard
/// can reach matters here: at six times zoom, the mouse would otherwise be the
/// only way to see the other three quarters of the map.
const KEY_PAN = 60;

/// Where a double click lands. Two and a half times is a quarter of the map
/// filling the dialog, which is the "let me look at that spawn" step.
const DOUBLE_CLICK_SCALE = 2.5;

/**
 * Put the preview PNG on the clipboard.
 *
 * Not through `fetch`: the client's CSP allows the frontend no network at all
 * (`connect-src ipc:`), and that rule is worth more than one convenience. A
 * second `Image` with `crossOrigin` set is loaded from the URL the visible one
 * already has in cache, drawn to a canvas, and read back out of it.
 *
 * The copy is what carries `crossOrigin`, deliberately: setting it on the
 * visible image would turn a preview host that sends no CORS header into a
 * broken image rather than an uncopyable one.
 */
async function copyImageToClipboard(url: string): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("this webview cannot put an image on the clipboard");
  }
  const image = new Image();
  image.crossOrigin = "anonymous";
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("preview could not be read for copying"));
  });
  image.src = url;
  await loaded;

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d canvas context");
  context.drawImage(image, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("preview could not be encoded as a PNG");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

/**
 * A map image, zoomable and copyable.
 *
 * A client that is not run full screen shows a preview at whatever size the
 * window allows, which for a 1024 px picture of a twenty kilometre map is not
 * enough to read a mex layout. Wheel to zoom, drag to pan, double-click to
 * jump in and back out, and the same through buttons and the keyboard.
 *
 * Takes the image as a child rather than drawing one, because the two places
 * that need this resolve their art differently: the Maps tab has a `VaultMap`
 * and its fallbacks, the Play tab has a game's map name and the generated
 * previews that go with it. Everything here works on whatever `<img>` ends up
 * inside, including the copy, which reads the `currentSrc` the browser settled
 * on rather than a URL guessed up front.
 */
export function ZoomableImage({ label, children, actions, overlay }: {
  label: string;
  children: ReactNode;
  /** Buttons of the caller's own, drawn just before Copy image. */
  actions?: ReactNode;
  /** Laid over the picture's frame and not zoomed with it, such as the
   *  generate button in the corner that the small preview has too. */
  overlay?: ReactNode;
}) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<ZoomTransform>(NO_ZOOM);
  const [copied, setCopied] = useState<"idle" | "image" | "link" | "failed">("idle");
  const [isDragging, setIsDragging] = useState(false);
  const [isWheeling, setIsWheeling] = useState(false);
  // The gestures, opened by the info button. It used to say them only on
  // hover, and a click on it did nothing.
  const [helpOpen, setHelpOpen] = useState(false);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const wheelTimeoutRef = useRef<number | null>(null);

  const size = () => {
    const box = viewportRef.current?.getBoundingClientRect();
    return { width: box?.width ?? 0, height: box?.height ?? 0 };
  };
  const pointIn = (event: { clientX: number; clientY: number }) => {
    const box = viewportRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };
  const centre = () => {
    const { width, height } = size();
    return { x: width / 2, y: height / 2 };
  };

  // A different map under an open dialog is not a reason to keep looking at
  // the corner of the last one.
  useEffect(() => {
    setTransform(NO_ZOOM);
    setCopied("idle");
  }, [label]);

  // Registered by hand, because React's `onWheel` is passive and a passive
  // listener may not call `preventDefault`. Without that the wheel scrolls the
  // dialog behind the image instead of zooming it.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setIsWheeling(true);
      if (wheelTimeoutRef.current !== null) {
        window.clearTimeout(wheelTimeoutRef.current);
      }
      wheelTimeoutRef.current = window.setTimeout(() => {
        setIsWheeling(false);
        wheelTimeoutRef.current = null;
      }, 150);

      setTransform((current) =>
        zoomByWheel(current, event.deltaY, pointIn(event), size()));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", onWheel);
      if (wheelTimeoutRef.current !== null) {
        window.clearTimeout(wheelTimeoutRef.current);
      }
    };
  }, []);

  const zoomStep = (direction: 1 | -1) => {
    setTransform((current) => zoomByStep(current, direction, centre(), size()));
  };

  const copy = () => {
    const url = viewportRef.current?.querySelector("img")?.currentSrc;
    if (!url) {
      setCopied("failed");
      return;
    }
    // The image first, then its address.
    //
    // Putting a PNG on the clipboard needs a permission the webview is allowed
    // to refuse, and the address is not a consolation prize: the reason given
    // for wanting this was pasting a map into a Discord message, and Discord
    // unfurls a link to a PNG into the picture itself. Text is also the
    // clipboard call this client already makes in eight other places, so it is
    // the one known to work everywhere the client runs.
    //
    // Which of the two happened is on the button, because pasting and finding
    // the wrong thing is worse than being told.
    ipc.run(
      copyImageToClipboard(url).then(
        () => setCopied("image"),
        () => navigator.clipboard.writeText(url).then(
          () => setCopied("link"),
          () => setCopied("failed"),
        ),
      ),
    );
  };

  const zoomed = transform.scale > MIN_SCALE;
  const viewportClass = [
    "map-preview-viewport",
    zoomed ? "is-zoomed" : "",
    isDragging ? "is-dragging" : "",
    isWheeling ? "is-wheeling" : "",
  ].filter(Boolean).join(" ");

  const copyLabel = t(copied === "image"
    ? "maps.preview.imageCopied"
    : copied === "link"
      ? "maps.preview.linkCopied"
      : copied === "failed"
        ? "maps.preview.copyFailed"
        : "maps.preview.copyImage");

  return (
    <div className="map-preview-zoom">
      <div className="map-preview-stage">
      <div
        ref={viewportRef}
        className={viewportClass}
        role="img"
        aria-label={t("maps.preview.zoomAria", { name: label })}
        tabIndex={0}
        onPointerDown={(event) => {
          if (!zoomed || event.button !== 0) return;
          dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          setIsDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const delta = { x: event.clientX - drag.x, y: event.clientY - drag.y };
          dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          setTransform((current) => panBy(current, delta, size()));
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null;
            setIsDragging(false);
          }
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setIsDragging(false);
        }}
        onDoubleClick={(event) => {
          // In, unless the reader is already in. A double click at 130 % that
          // jumped straight back out read as the control ignoring the gesture,
          // because a closer look is the thing somebody double-clicks a map for.
          setTransform((current) => zoomTo(
            current,
            current.scale >= DOUBLE_CLICK_SCALE ? MIN_SCALE : DOUBLE_CLICK_SCALE,
            pointIn(event),
            size(),
          ));
        }}
        onKeyDown={(event) => {
          const pan = (x: number, y: number) => {
            event.preventDefault();
            setTransform((current) => panBy(current, { x, y }, size()));
          };
          switch (event.key) {
            case "+":
            case "=":
              event.preventDefault();
              zoomStep(1);
              break;
            case "-":
              event.preventDefault();
              zoomStep(-1);
              break;
            case "0":
              event.preventDefault();
              setTransform(NO_ZOOM);
              break;
            case "ArrowLeft": pan(KEY_PAN, 0); break;
            case "ArrowRight": pan(-KEY_PAN, 0); break;
            case "ArrowUp": pan(0, KEY_PAN); break;
            case "ArrowDown": pan(0, -KEY_PAN); break;
          }
        }}
      >
        <div
          className="map-preview-canvas"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          }}
        >
          {children}
        </div>
      </div>
      {overlay}
      </div>
      {/* Under the picture, not on it: the zoom at the start of the row, and
          at its end the caller's buttons and Copy image, as icons. One zoom
          control, not three: reset is the stepper's last segment, the
          percentage only says how far in the picture is, and the gestures are
          on the info mark beside it. */}
      <div className="map-preview-controls">
        <div className="map-preview-zoom-buttons" role="group" aria-label={t("maps.preview.zoomGroup")}>
          <div className="map-preview-stepper">
            <button
              type="button"
              className="map-preview-stepper-btn"
              disabled={transform.scale <= MIN_SCALE}
              onClick={() => zoomStep(-1)}
              title={t("maps.preview.zoomOut")}
              aria-label={t("maps.preview.zoomOut")}
            >
              <Icon name="minus" size={14} />
            </button>
            <output className="map-preview-stepper-value">
              {Math.round(transform.scale * 100)}%
            </output>
            <button
              type="button"
              className="map-preview-stepper-btn"
              disabled={transform.scale >= MAX_SCALE}
              onClick={() => zoomStep(1)}
              title={t("maps.preview.zoomIn")}
              aria-label={t("maps.preview.zoomIn")}
            >
              <Icon name="plus" size={14} />
            </button>
            <button
              type="button"
              className="map-preview-stepper-btn map-preview-stepper-reset"
              disabled={!zoomed}
              onClick={() => setTransform(NO_ZOOM)}
              title={t("maps.preview.resetZoom")}
              aria-label={t("maps.preview.resetZoom")}
            >
              <Icon name="refresh" size={14} />
            </button>
          </div>
          <span className="map-preview-help-wrap">
            <button
              type="button"
              className={helpOpen ? "map-preview-help is-open" : "map-preview-help"}
              aria-expanded={helpOpen}
              aria-label={t("maps.preview.zoomHint")}
              onClick={() => setHelpOpen((open) => !open)}
              onBlur={() => setHelpOpen(false)}
            >
              <Icon name="info" size={15} />
            </button>
            {helpOpen && (
              <span className="map-preview-help-popover" role="tooltip">
                {t("maps.preview.zoomHint")}
              </span>
            )}
          </span>
        </div>
        <div className="map-preview-actions">
          {actions}
          {/* The copy icon the client uses everywhere else, in the corner under
              the picture; what it did is said on its tooltip, and the icon
              turns into a tick once the picture is on the clipboard. */}
          <button
            type="button"
            className="map-preview-icon-btn"
            onClick={copy}
            title={copyLabel}
            aria-label={copyLabel}
          >
            <Icon name={copied === "image" || copied === "link" ? "check" : "copy"} size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The chrome every enlarged map preview wears: a title over a zoomable
 * picture, with whatever the tab knows about the map underneath.
 *
 * Four screens open a map at full size -- the Maps tab, the Play tab's game
 * preview, the generator, the replay detail card -- and until this existed
 * each had built its own heading, which is how one of them ended up with a
 * title half the size of the others and no room for what it was a preview
 * *of*. The frame is deliberately not a `Modal`: the replay card is itself a
 * modal and stacking two means one Escape closes both, so that caller draws
 * its own scrim and passes `onClose` to get a close button here instead.
 */
export function MapPreviewFrame({ kicker, title, subtitle, label, onClose, children, footer }: {
  /// The small line above the title, saying what kind of thing this is.
  kicker?: ReactNode;
  title: string;
  /// One line under the title: the lobby's name, the replay's title.
  subtitle?: ReactNode;
  /// What the zoom announces itself as. Defaults to the title.
  label?: string;
  /// Given only by a caller drawing its own scrim; `Modal` brings its own
  /// close button and a second one beside it reads as a mistake.
  onClose?: () => void;
  children: ReactNode;
  /// Everything below the picture: the technical name, the facts, the actions.
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="map-preview-frame">
      <header className="map-preview-frame-head">
        <div className="map-preview-frame-titles">
          {kicker && <span className="map-preview-frame-kicker">{kicker}</span>}
          <h2 title={title}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {onClose && (
          <button
            type="button"
            className="map-preview-frame-close"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <Icon name="close" size={16} />
          </button>
        )}
      </header>
      <ZoomableImage label={label ?? title}>{children}</ZoomableImage>
      {footer}
    </div>
  );
}

/**
 * Copies a map's name, beside the title it belongs to: the name as it reads,
 * without the folder's version suffix, except for a generated map, whose
 * full name is the only way back to it. The icon turns into a tick for two
 * seconds once the name is on the clipboard.
 */
export function CopyMapNameButton({ name, generated = false }: {
  name: string;
  /// A generated map's name can be pasted into Generate map, which the
  /// tooltip says.
  generated?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const words = t(copied
    ? "lobby.browser.mapNameCopied"
    : generated
      ? "lobby.browser.copyMapNameGenerated"
      : "lobby.browser.copyMapName");
  return (
    <button
      type="button"
      className="map-preview-title-copy"
      aria-label={words}
      title={words}
      onClick={() => ipc.run(navigator.clipboard.writeText(name).then(() => setCopied(true)))}
    >
      <Icon name={copied ? "check" : "copy"} size={15} />
    </button>
  );
}

/**
 * Opens the map in the Maps tab's vault: searched for by name, with the
 * version shown here selected, so its detail panel is open on arrival. Beside
 * the star and Copy image under the picture. `onNavigate` closes whatever
 * dialog the button sits in first.
 */
export function OpenMapInVaultButton({ name, folderName, onNavigate }: {
  name: string;
  folderName: string;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      onClick={() => {
        requestMapVaultFocus({ name, folderName });
        onNavigate?.();
        ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "maps" } } });
      }}
    >
      <Icon name="maps" size={14} />
      {t("maps.preview.openInVault")}
    </Button>
  );
}

/**
 * The favourite as a star, the way the vault's cards show it: filled when the
 * map is starred, its words on the tooltip. Shared by the map preview dialog
 * and the Play tab's game preview, which both put it beside Copy image.
 */
export function FavoriteMapStar({ favorite, label, onToggle }: {
  favorite: boolean;
  label: string;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const words = t(favorite ? "maps.vault.removeFavoriteAria" : "maps.vault.addFavoriteAria", { name: label });
  return (
    <button
      type="button"
      className={favorite ? "map-preview-icon-btn is-favorite" : "map-preview-icon-btn"}
      aria-pressed={favorite}
      aria-label={words}
      title={words}
      onClick={onToggle}
    >
      <Icon name="star" size={15} fill={favorite ? "currentColor" : "none"} />
    </button>
  );
}

/**
 * A map opened at full size in a dialog of its own: the Maps tab, the host
 * dialog, a chat game card and the matchmaker's map pool all open this one.
 *
 * Built the way the Play tab's game preview is, which is the one people know:
 * "Map preview" over the map's name and what the tab knows about it, the
 * picture as large as the window allows with the zoom and a star to keep the
 * map, and the full technical name underneath, copyable. This used to be a
 * smaller frame of its own, so a map looked different depending on which tab
 * it was opened from.
 */
export function MapPreviewDialog({ map, meta, onClose, children, downloadUrl, vaultLink = true }: {
  map: PreviewableMap;
  /// Whether to offer "Open in the map vault": not from the vault itself.
  vaultLink?: boolean;
  /// The line under the title: size, player count, whatever the tab knows.
  meta?: ReactNode;
  /// The image to zoom, for a caller that resolves map art its own way: the
  /// lobby's `MapThumbnail` knows about generated previews the vault has never
  /// heard of. Defaults to the vault's own `MapPreview`.
  children?: ReactNode;
  /// Where the map's zip is, so starring a map that is not on disk can fetch it.
  downloadUrl?: string;
  onClose: () => void;
}) {
  const label = map.displayName || map.folderName;
  const favorite = useIsFavoriteMap(map.folderName);
  return (
    <Modal onClose={onClose} className="map-preview-modal">
      <div className="map-preview-dialog">
        {/* The map's name, not "Map preview" over it: what kind of dialog
            this is shows from the picture under it. */}
        <header className="map-preview-dialog-header">
          <div className="map-preview-title-row">
            <h2 title={label}>{label}</h2>
            <CopyMapNameButton name={label} />
          </div>
          {meta && <p>{meta}</p>}
        </header>
        <ZoomableImage
          label={label}
          actions={map.folderName ? (
            <>
              {vaultLink && !isGeneratedMap(map.folderName) && (
                <OpenMapInVaultButton name={label} folderName={map.folderName} onNavigate={onClose} />
              )}
              <FavoriteMapStar
                favorite={favorite}
                label={label}
                onToggle={() => toggleFavoriteMap(map.folderName, downloadUrl)}
              />
            </>
          ) : undefined}
        >
          {children ?? <MapPreview map={map} large />}
        </ZoomableImage>
      </div>
    </Modal>
  );
}
