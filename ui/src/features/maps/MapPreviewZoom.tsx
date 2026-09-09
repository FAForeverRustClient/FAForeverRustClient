import { useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { MapPreview, type PreviewableMap } from "./MapVaultComponents";
import {
  MAX_SCALE,
  MIN_SCALE,
  NO_ZOOM,
  panBy,
  zoomByStep,
  zoomTo,
  type ZoomTransform,
} from "./mapZoom";

/// How far an arrow key moves the view, in viewport pixels. A pan the keyboard
/// can reach matters here: at six times zoom, the mouse would otherwise be the
/// only way to see the other three quarters of the map.
const KEY_PAN = 60;

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
 * The map preview, zoomable and copyable.
 *
 * A client that is not run full screen shows this dialog at whatever size the
 * window allows, which for a 1024 px preview of a twenty kilometre map is not
 * enough to read a mex layout. Wheel to zoom, drag to pan, double-click to
 * jump in and back out, and the same through buttons and the keyboard.
 */
export function MapPreviewZoom({ map }: { map: PreviewableMap }) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<ZoomTransform>(NO_ZOOM);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

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
  }, [map.folderName]);

  // Registered by hand, because React's `onWheel` is passive and a passive
  // listener may not call `preventDefault`. Without that the wheel scrolls the
  // dialog behind the image instead of zooming it.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setTransform((current) =>
        zoomByStep(current, event.deltaY < 0 ? 1 : -1, pointIn(event), size()));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
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
    // Reported either way: a clipboard that refused is worth knowing about
    // before pasting into a Discord message and finding nothing there.
    ipc.run(
      copyImageToClipboard(url).then(
        () => setCopied("done"),
        () => setCopied("failed"),
      ),
    );
  };

  const zoomed = transform.scale > MIN_SCALE;
  return (
    <div className="map-preview-zoom">
      <div
        ref={viewportRef}
        className={zoomed ? "map-preview-viewport is-zoomed" : "map-preview-viewport"}
        role="img"
        aria-label={t("maps.preview.zoomAria", { name: map.displayName || map.folderName })}
        tabIndex={0}
        onPointerDown={(event) => {
          if (!zoomed) return;
          dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
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
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
        }}
        onPointerCancel={() => { dragRef.current = null; }}
        onDoubleClick={(event) => {
          setTransform((current) =>
            zoomTo(current, current.scale > MIN_SCALE ? MIN_SCALE : 2.5, pointIn(event), size()));
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
          <MapPreview map={map} large />
        </div>
      </div>
      <div className="map-preview-controls">
        <div className="map-preview-zoom-buttons" role="group" aria-label={t("maps.preview.zoomGroup")}>
          <Button
            disabled={transform.scale <= MIN_SCALE}
            onClick={() => zoomStep(-1)}
            title={t("maps.preview.zoomOut")}
            aria-label={t("maps.preview.zoomOut")}
          >
            <Icon name="chevronDown" size={14} />
          </Button>
          <span className="map-preview-zoom-level">{Math.round(transform.scale * 100)}%</span>
          <Button
            disabled={transform.scale >= MAX_SCALE}
            onClick={() => zoomStep(1)}
            title={t("maps.preview.zoomIn")}
            aria-label={t("maps.preview.zoomIn")}
          >
            <Icon name="chevronUp" size={14} />
          </Button>
          <Button
            disabled={!zoomed}
            onClick={() => setTransform(NO_ZOOM)}
            title={t("maps.preview.resetZoom")}
          >
            {t("maps.preview.resetZoom")}
          </Button>
        </div>
        <Button onClick={copy} title={t("maps.preview.copyImage")}>
          <Icon name={copied === "done" ? "check" : "copy"} size={14} />
          {t(copied === "done"
            ? "maps.preview.imageCopied"
            : copied === "failed"
              ? "maps.preview.copyFailed"
              : "maps.preview.copyImage")}
        </Button>
      </div>
      <p className="map-preview-hint muted">{t("maps.preview.zoomHint")}</p>
    </div>
  );
}
