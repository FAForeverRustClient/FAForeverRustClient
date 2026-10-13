// The overlay for the wait between pressing Join or Watch and Forged Alliance
// appearing.
//
// Two dialogs used to draw this themselves (`JoinPreparationDialog` and
// `ReplayStartDialog`), each with its own copy of the bar and its sweep, and
// they had drifted: different spacing, the primary button on Cancel in one and
// on nothing in the other. One layout now, and the dialogs only decide what
// goes into it.
//
// Three bands, as the cards elsewhere in the client have: a raised head that
// says what is starting (the map and the game's name, when the caller knows
// them), a body that says how far it is, and a foot with the ways out.
//
// The bar is segmented when the caller names stages: one segment per stage,
// the ones behind filled, the one in hand filling with its own percentage or
// sweeping when it has none. That is the whole of the progress, so there is
// one bar to read rather than a stage list and a bar beside it. Without stages
// it is one segment, which is the plain bar the replay start needs.

import { useState, type ReactNode } from "react";
import { Button } from "../../design-system/Button";
import { Icon, type IconName } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import type { VaultMap } from "../../ipc/bindings";
import { MapThumbnail } from "./MapThumbnail";
import "./launch-progress.css";

export interface LaunchContext {
  /** The map's folder name, for its picture. */
  mapName: string | null;
  /** Art the caller already holds for the map, tried first. */
  mapUrl?: string | null;
  /** What is starting: the lobby's title, the replay's title. */
  name: string;
  /** A second line under the name: the map's display name, the mod. */
  detail?: string | null;
}

export interface LaunchStages {
  labels: readonly string[];
  /** Index of the stage in hand. */
  current: number;
}

interface Props {
  className?: string;
  onClose: () => void;
  title: string;
  context?: LaunchContext | null;
  vault?: VaultMap[];
  /** The head's picture when there is no map to show. */
  icon?: IconName;
  /** Tints the head's icon: a failure. */
  iconTone?: "error";
  /** A line under the title when there is no context to show. */
  subtitle?: string | null;
  /** What is happening, in words: the stage's own name. */
  phase?: ReactNode;
  /** 0 to 100 for the stage in hand, `null` when it cannot say. */
  percent: number | null;
  /** Hides the bar, for a failure. */
  showBar?: boolean;
  stages?: LaunchStages | null;
  progressLabel: string;
  progressText: string;
  /** The file or step the stage is on, which changes once per file. */
  detail?: string | null;
  /** The detail is a sentence rather than a file name: no monospace. */
  detailIsText?: boolean;
  /** A line that matters more than the detail: the ICE adapter, a failure. */
  notice?: { tone: "info" | "warn" | "error"; text: string; title?: string } | null;
  /** The steps seen so far, behind a toggle. */
  log?: readonly string[] | null;
  logLabels?: { show: (count: number) => string; hide: string };
  /** A quiet way out at the foot's start: "do not show again". */
  footStart?: ReactNode;
  actions: ReactNode;
}

export function LaunchProgress({
  className,
  onClose,
  title,
  context,
  vault = [],
  icon,
  iconTone,
  subtitle,
  phase,
  percent,
  showBar = true,
  stages,
  progressLabel,
  progressText,
  detail,
  detailIsText = false,
  notice,
  log,
  logLabels,
  footStart,
  actions,
}: Props) {
  const [showLog, setShowLog] = useState(false);
  const labels = stages?.labels ?? [""];
  const current = stages ? Math.min(Math.max(stages.current, 0), labels.length - 1) : 0;

  return (
    <Modal
      className={["launch-progress-modal", className].filter(Boolean).join(" ")}
      onClose={onClose}
      ariaLabel={title}
    >
      <header className="launch-progress-head">
        {context?.mapName && (
          <MapThumbnail
            mapName={context.mapName}
            vault={vault}
            url={context.mapUrl}
            className="launch-progress-map"
            placeholderClassName="launch-progress-map is-placeholder"
            iconSize={20}
          />
        )}
        {!context?.mapName && icon && (
          <span className="launch-progress-map is-placeholder" data-tone={iconTone} aria-hidden="true">
            <Icon name={icon} size={22} />
          </span>
        )}
        <div className="launch-progress-heading">
          <h2>{title}</h2>
          {context ? (
            <p className="launch-progress-context">
              <span className="launch-progress-name" title={context.name}>{context.name}</span>
              {context.detail && <span className="launch-progress-sub">{context.detail}</span>}
            </p>
          ) : (
            subtitle && <p className="launch-progress-context"><span className="launch-progress-sub">{subtitle}</span></p>
          )}
        </div>
      </header>

      <div className="launch-progress-body">
        {(phase || percent !== null) && showBar && (
          <div className="launch-progress-status">
            <span className="launch-progress-phase">{phase}</span>
            {percent !== null && <span className="launch-progress-percent">{percent}%</span>}
          </div>
        )}

        {showBar && (
          <div
            className="launch-progress-bar"
            data-indeterminate={percent === null ? "true" : undefined}
            role="progressbar"
            aria-label={progressLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={progressText}
            style={{ gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))` }}
          >
            {labels.map((label, index) => (
              <div
                key={label || index}
                className="launch-progress-segment"
                data-state={index < current ? "done" : index === current ? "current" : "next"}
              >
                <span className="launch-progress-track">
                  <span
                    className="launch-progress-fill"
                    style={index === current && percent !== null
                      ? { transform: `scaleX(${percent / 100})` }
                      : undefined}
                  />
                </span>
                {label && (
                  <span className="launch-progress-label">
                    {index < current && <Icon name="check" size={11} />}
                    {label}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {detail && showBar && (
          <p
            className={detailIsText ? "launch-progress-detail is-text" : "launch-progress-detail"}
            title={detail}
            aria-live="polite"
          >{detail}</p>
        )}

        {notice && (
          <p className="launch-progress-notice" data-tone={notice.tone} title={notice.title}>
            <Icon name={notice.tone === "info" ? "info" : "alert"} size={15} />
            <span>{notice.text}</span>
          </p>
        )}

        {log && logLabels && log.length > 0 && (
          <div className="launch-progress-log">
            <Button
              className="launch-progress-log-toggle"
              aria-expanded={showLog}
              onClick={() => setShowLog((open) => !open)}
            >
              <Icon name={showLog ? "chevronUp" : "chevronDown"} size={14} />
              {showLog ? logLabels.hide : logLabels.show(log.length)}
            </Button>
            {showLog && (
              <ol className="launch-progress-log-list">
                {log.map((line, index) => (
                  <li key={`${index}-${line}`} className={index === log.length - 1 ? "is-current" : undefined}>
                    {line}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>

      <footer className="launch-progress-foot">
        {footStart}
        <div className="launch-progress-actions">{actions}</div>
      </footer>
    </Modal>
  );
}
