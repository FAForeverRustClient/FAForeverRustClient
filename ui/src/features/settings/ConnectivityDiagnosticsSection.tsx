// The connectivity check and the live relay view, under Settings >
// Connectivity, beside the adapter choice they diagnose.
//
// Both halves only select state and send commands. The check's lines arrive
// from the backend one by one with their outcome already decided; this file
// only phrases each finding in the reader's language. The live view asks the
// running adapter for its peers on a timer, and only while a game runs and
// this page is the one open: nothing is polled from a page nobody is reading.

import { useEffect, useId, useState } from "react";

import { Button } from "../../design-system/Button";
import { Icon, type IconName } from "../../design-system/Icon";
import { StatusNotice } from "../../design-system/StatusNotice";
import type { MessageKey } from "../../i18n";
import { useTranslation, type Translation } from "../../i18n/useTranslation";
import type {
  CheckFinding,
  CheckOutcome,
  CheckStep,
  ConnectivityCheck,
  IceAdapter,
  IceTransport,
  ProbeFailure,
  RelayPeer,
  RelayStatus,
} from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { native } from "../../ipc/native";
import { formatShortDateTime, formatTime } from "../../shared/format/dates";
import { plainError } from "../../shared/plainError";
import { useAppStore } from "../../store/store";
import { SettingRow, SettingsGroup } from "./SettingControls";
import "./connectivity-check.css";

/** How often the live view asks the adapter, as the Python client's dialog does. */
const RELAY_POLL_MS = 2_000;

type Translate = Translation["t"];

const ADAPTER: Record<IceAdapter, MessageKey> = {
  dynamic: "settings.connectivityCheck.adapter.dynamic",
  java: "settings.connectivityCheck.adapter.java",
  expJava: "settings.connectivityCheck.adapter.expJava",
  go: "settings.connectivityCheck.adapter.go",
};

const TRANSPORT: Record<IceTransport, MessageKey> = {
  udp: "settings.connectivityCheck.transport.udp",
  tcp: "settings.connectivityCheck.transport.tcp",
  tls: "settings.connectivityCheck.transport.tls",
};

// The icon is never the only signal: each mark also carries its outcome as
// its accessible name, and the row its colour.
const OUTCOME_ICON: Record<CheckOutcome, IconName> = {
  running: "refresh",
  info: "info",
  pass: "check",
  warn: "alert",
  fail: "alert",
};

const OUTCOME_LABEL: Record<CheckOutcome, MessageKey> = {
  running: "settings.connectivityCheck.outcome.running",
  info: "settings.connectivityCheck.outcome.info",
  pass: "settings.connectivityCheck.outcome.pass",
  warn: "settings.connectivityCheck.outcome.warn",
  fail: "settings.connectivityCheck.outcome.fail",
};

const VERDICT: Record<CheckOutcome, MessageKey> = {
  running: "settings.connectivityCheck.running",
  info: "settings.connectivityCheck.verdict.pass",
  pass: "settings.connectivityCheck.verdict.pass",
  warn: "settings.connectivityCheck.verdict.warn",
  fail: "settings.connectivityCheck.verdict.fail",
};

/** The adapter's own words for an ICE state, phrased for a player. */
const PEER_STATE: Record<string, MessageKey> = {
  new: "settings.liveRelay.state.new",
  gathering: "settings.liveRelay.state.gathering",
  awaitingCandidates: "settings.liveRelay.state.awaitingCandidates",
  checking: "settings.liveRelay.state.checking",
  connected: "settings.liveRelay.state.connected",
  completed: "settings.liveRelay.state.completed",
  disconnected: "settings.liveRelay.state.disconnected",
};

interface Phrased {
  title: string;
  detail: string;
  /** The title is an address, drawn in the monospace face. */
  address?: boolean;
  /** The full installation path, available without crowding the result. */
  path?: string;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

// The reasons inside a finding stay as the probe reported them, unlike the
// failure of an action such as opening the log folder. A finding is a
// diagnosis, read to be pasted into a support thread, and the plain causes
// `plainError` knows speak of "the server" and "your connection", which is
// exactly what a probe is asking about: "connection refused" from a relay is
// the answer, and from the adapter on this machine it is not the server at
// all. The same goes for the live view's "the adapter did not answer".
function failureText(failure: ProbeFailure, transport: string, t: Translate): string {
  switch (failure.type) {
    case "timeout":
      return t("settings.connectivityCheck.server.timeout", {
        transport,
        seconds: Math.max(1, Math.round(failure.payload.waitedMs / 1000)),
      });
    case "unknownHost":
      return t("settings.connectivityCheck.server.unknownHost");
    case "refused":
      return t("settings.connectivityCheck.server.refused", { transport });
    case "badAnswer":
      return t("settings.connectivityCheck.server.badAnswer", { reason: failure.payload.reason });
    case "network":
      return t("settings.connectivityCheck.server.network", { transport, reason: failure.payload.reason });
  }
}

/** A finding as a title and a sentence. */
export function phraseFinding(finding: CheckFinding, t: Translate): Phrased {
  switch (finding.type) {
    case "adapterSelection": {
      const { join, host, forced } = finding.payload;
      return {
        title: t("settings.connectivityCheck.selection.title"),
        detail: forced
          ? t("settings.connectivityCheck.selection.forced", { adapter: t(ADAPTER[forced]) })
          : t("settings.connectivityCheck.selection.detail", { join: t(ADAPTER[join]), host: t(ADAPTER[host]) }),
      };
    }
    case "javaRuntime": {
      const { path, version } = finding.payload;
      return {
        title: t("settings.connectivityCheck.javaRuntime.title"),
        detail: version
          ? t("settings.connectivityCheck.javaRuntime.found", { version, path: fileName(path) })
          : t("settings.connectivityCheck.javaRuntime.unknownVersion", { path: fileName(path) }),
        path,
      };
    }
    case "javaRuntimeTooOld":
      return {
        title: t("settings.connectivityCheck.javaRuntime.title"),
        detail: t("settings.connectivityCheck.javaRuntime.tooOld", { ...finding.payload, path: fileName(finding.payload.path) }),
        path: finding.payload.path,
      };
    case "javaRuntimeMissing":
      return {
        title: t("settings.connectivityCheck.javaRuntime.title"),
        detail: t("settings.connectivityCheck.javaRuntime.missing", { ...finding.payload, path: fileName(finding.payload.path) }),
        path: finding.payload.path,
      };
    case "javaAdapter":
      return {
        title: t("settings.connectivityCheck.javaAdapter.title"),
        detail: t("settings.connectivityCheck.javaAdapter.found", { path: fileName(finding.payload.path) }),
        path: finding.payload.path,
      };
    case "javaAdapterMissing":
      return {
        title: t("settings.connectivityCheck.javaAdapter.title"),
        detail: t("settings.connectivityCheck.javaAdapter.missing"),
      };
    case "pioneerAdapter":
      return {
        title: t("settings.connectivityCheck.pioneer.title"),
        detail: t("settings.connectivityCheck.pioneer.found", { path: fileName(finding.payload.path) }),
        path: finding.payload.path,
      };
    case "pioneerAdapterMissing":
      return {
        title: t("settings.connectivityCheck.pioneer.title"),
        detail: finding.payload.required
          ? t("settings.connectivityCheck.pioneer.missingRequired")
          : t("settings.connectivityCheck.pioneer.missingOptional"),
      };
    case "relayList": {
      const { count, regions } = finding.payload;
      return {
        title: t("settings.connectivityCheck.relayList.title"),
        detail:
          count === 0
            ? t("settings.connectivityCheck.relayList.empty")
            : t("settings.connectivityCheck.relayList.found", { count, regions: regions.join(", ") }),
      };
    }
    case "relayListNeedsSignIn":
      return {
        title: t("settings.connectivityCheck.relayList.title"),
        detail: t("settings.connectivityCheck.relayList.signIn"),
      };
    case "relayListUnavailable":
      return {
        title: t("settings.connectivityCheck.relayList.title"),
        detail: t("settings.connectivityCheck.relayList.unavailable", finding.payload),
      };
    case "relayAddresses": {
      const { count, gameId } = finding.payload;
      return {
        title: t("settings.connectivityCheck.addresses.title"),
        detail:
          count === 0
            ? t("settings.connectivityCheck.addresses.emptySession", { gameId })
            : t("settings.connectivityCheck.addresses.known", { count, gameId }),
      };
    }
    case "noRelayAddresses":
      return {
        title: t("settings.connectivityCheck.addresses.title"),
        detail: t("settings.connectivityCheck.addresses.none"),
      };
    case "relayAddressesUnavailable":
      return {
        title: t("settings.connectivityCheck.addresses.title"),
        detail: t("settings.connectivityCheck.addresses.unavailable", finding.payload),
      };
    case "serverProbing":
      return {
        title: finding.payload.url,
        address: true,
        detail: t("settings.connectivityCheck.server.probing", { transport: t(TRANSPORT[finding.payload.transport]) }),
      };
    case "serverReachable": {
      const { url, transport, roundTripMs, publicAddress } = finding.payload;
      const via = t(TRANSPORT[transport]);
      let detail: string;
      if (transport !== "udp") {
        detail = t("settings.connectivityCheck.server.connected", { transport: via, ms: roundTripMs });
      } else if (publicAddress) {
        detail = t("settings.connectivityCheck.server.answeredAt", {
          transport: via,
          ms: roundTripMs,
          address: publicAddress,
        });
      } else {
        detail = t("settings.connectivityCheck.server.answered", { transport: via, ms: roundTripMs });
      }
      return { title: url, address: true, detail };
    }
    case "serverUnreachable":
      return {
        title: finding.payload.url,
        address: true,
        detail: failureText(finding.payload.failure, t(TRANSPORT[finding.payload.transport]), t),
      };
    case "serverUnreadable":
      return {
        title: finding.payload.url,
        address: true,
        detail: t("settings.connectivityCheck.server.unreadable"),
      };
    case "reachability": {
      const { answered, total, udpBlocked } = finding.payload;
      let detail: string;
      if (answered === total) {
        detail = t("settings.connectivityCheck.reachability.all", { count: total, total });
      } else if (answered === 0) {
        detail = t("settings.connectivityCheck.reachability.none");
      } else {
        detail = t("settings.connectivityCheck.reachability.some", { answered, total });
      }
      if (udpBlocked) detail = `${detail} ${t("settings.connectivityCheck.reachability.udpBlocked")}`;
      return { title: t("settings.connectivityCheck.reachability.title"), detail };
    }
    case "adapterLog":
      return {
        title: t("settings.connectivityCheck.log.title"),
        detail: t("settings.connectivityCheck.log.found", {
          file: finding.payload.fileName,
          time: formatShortDateTime(finding.payload.modifiedAt),
        }),
      };
    case "noAdapterLog":
      return {
        title: t("settings.connectivityCheck.log.title"),
        detail: t("settings.connectivityCheck.log.none"),
      };
  }
}

function OutcomeMark({ outcome }: { outcome: CheckOutcome }) {
  const { t } = useTranslation();
  return (
    <span className="connectivity-check-mark" role="img" aria-label={t(OUTCOME_LABEL[outcome])}>
      <Icon name={OUTCOME_ICON[outcome]} size={15} />
    </span>
  );
}

/** A quiet "show more" control at the end of a check line. */
function LineToggle({ open, controls, label, onToggle }: {
  open: boolean;
  controls: string;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="connectivity-check-toggle"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
    >
      <span>{label}</span>
      <Icon name="chevronDown" size={12} className={open ? "is-open" : undefined} />
    </button>
  );
}

/**
 * The full installation path behind a line that names only the file: asked
 * for at the end of the line, shown under it, so a passing line stays one
 * line.
 */
function InstallPath({ path }: { path: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <div className="connectivity-check-actions">
        <LineToggle
          open={open}
          controls={id}
          label={open ? t("settings.connectivityCheck.hidePath") : t("settings.connectivityCheck.showPath")}
          onToggle={() => setOpen((shown) => !shown)}
        />
      </div>
      {open && <code id={id} className="connectivity-check-extra connectivity-check-path">{path}</code>}
    </>
  );
}

/**
 * The adapter's log, folded away until asked for: it is long and technical.
 * Its controls sit at the end of the line, the log itself under it.
 */
function AdapterLogBlock({ fileName, tail, truncated }: { fileName: string; tail: string; truncated: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const id = useId();
  const openFolder = () => {
    setError("");
    void native.openLogFolder("ice").catch((reason: unknown) => setError(String(reason)));
  };

  return (
    <>
      <div className="connectivity-check-actions">
        <LineToggle
          open={open}
          controls={id}
          label={open ? t("settings.connectivityCheck.log.hide") : t("settings.connectivityCheck.log.show")}
          onToggle={() => setOpen((shown) => !shown)}
        />
        <Button className="connectivity-check-action" onClick={openFolder}>
          {t("settings.connectivityCheck.log.openFolder")}
        </Button>
      </div>
      {(open || error) && (
        <div className="connectivity-check-extra connectivity-check-log">
          {open && (
            <div id={id} className="connectivity-check-log-body">
              <div className="connectivity-check-log-bar">
                {truncated && <p className="connectivity-check-note">{t("settings.connectivityCheck.log.truncated")}</p>}
                <Button
                  className="connectivity-check-action"
                  onClick={() => void navigator.clipboard.writeText(tail).catch(() => undefined)}
                >
                  {t("settings.connectivityCheck.log.copy")}
                </Button>
              </div>
              <pre
                className="connectivity-check-log-text"
                tabIndex={0}
                aria-label={t("settings.connectivityCheck.log.contents", { file: fileName })}
              >
                {tail}
              </pre>
            </div>
          )}
          {/* Opening the folder is an action, not a finding, so its failure is
              worded like any other: plainly, with the shell's words on hover. */}
          {error && (
            <StatusNotice
              tone="error"
              className="connectivity-check-failure"
              action={{ label: t("common.retry"), onClick: openFolder }}
              detail={error}
            >
              {plainError(error)}
            </StatusNotice>
          )}
        </div>
      )}
    </>
  );
}

// One line per finding: the mark, a short title and its sentence side by side,
// and anything more (a path, the log) folded under it. An address is too long
// for the title column, so it takes the line and its sentence goes under it.
function CheckLine({ step }: { step: CheckStep }) {
  const { t } = useTranslation();
  const phrased = phraseFinding(step.finding, t);
  return (
    <li
      className="connectivity-check-line"
      data-outcome={step.outcome}
      data-address={phrased.address || undefined}
      data-log={step.finding.type === "adapterLog" || undefined}
    >
      <OutcomeMark outcome={step.outcome} />
      <span className={`connectivity-check-title${phrased.address ? " is-address" : ""}`}>{phrased.title}</span>
      <span className="connectivity-check-detail">{phrased.detail}</span>
      {phrased.path && phrased.path !== fileName(phrased.path) && <InstallPath path={phrased.path} />}
      {step.finding.type === "adapterLog" && (
        <AdapterLogBlock
          fileName={step.finding.payload.fileName}
          tail={step.finding.payload.tail}
          truncated={step.finding.payload.truncated}
        />
      )}
    </li>
  );
}

export function CheckResults({ check }: { check: ConnectivityCheck }) {
  const { t } = useTranslation();
  const verdict: CheckOutcome = check.status.type === "finished" ? check.status.payload.verdict : "running";
  return (
    <div className="setting-block connectivity-check" aria-busy={verdict === "running"}>
      {/* The verdict heads the lines it sums up, in one box with them. */}
      <div className="connectivity-check-box">
        <p className="connectivity-check-summary" data-outcome={verdict} role="status">
          <OutcomeMark outcome={verdict} />
          <span className="connectivity-check-verdict">{t(VERDICT[verdict])}</span>
          {check.startedAt && (
            <span className="connectivity-check-when">
              {t("settings.connectivityCheck.startedAt", { time: formatTime(check.startedAt) })}
            </span>
          )}
        </p>
        <ul className="connectivity-check-lines">
          {check.steps.map((step) => (
            <CheckLine key={step.id} step={step} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function peerRoute(peer: RelayPeer): MessageKey {
  if (peer.localCandidate === "relay" || peer.remoteCandidate === "relay") return "settings.liveRelay.route.relay";
  if (peer.localCandidate && peer.remoteCandidate) return "settings.liveRelay.route.direct";
  return "settings.liveRelay.route.pending";
}

export function LiveRelay({ relay }: { relay: RelayStatus }) {
  const { t } = useTranslation();
  switch (relay.type) {
    case "idle":
      return <p className="setting-block connectivity-relay-note">{t("settings.liveRelay.asking")}</p>;
    case "unsupported":
      return <p className="setting-block connectivity-relay-note">{t("settings.liveRelay.unsupported")}</p>;
    case "unavailable":
      return (
        <p className="setting-block connectivity-relay-note" role="alert">
          {t("settings.liveRelay.unavailable", { reason: relay.payload.reason })}
        </p>
      );
    case "live": {
      const { snapshot } = relay.payload;
      return (
        <div className="setting-block connectivity-relay">
          <p className="connectivity-relay-summary">
            {t("settings.liveRelay.summary", {
              version: snapshot.adapterVersion || t("common.unknown"),
              state: snapshot.gameState || t("common.unknown"),
            })}
          </p>
          {snapshot.peers.length === 0 ? (
            <p className="connectivity-relay-note">{t("settings.liveRelay.noPeers")}</p>
          ) : (
            <table className="connectivity-relay-table">
              <thead>
                <tr>
                  <th scope="col">{t("settings.liveRelay.player")}</th>
                  <th scope="col">{t("settings.liveRelay.state")}</th>
                  <th scope="col">{t("settings.liveRelay.route")}</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.peers.map((peer) => (
                  <tr key={peer.playerId} data-connected={peer.connected}>
                    <td>{peer.login || t("settings.liveRelay.unknownPlayer", { id: peer.playerId })}</td>
                    <td>
                      <span className="connectivity-relay-dot" aria-hidden="true" />
                      {PEER_STATE[peer.state] ? t(PEER_STATE[peer.state]) : peer.state}
                    </td>
                    <td>{t(peerRoute(peer))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      );
    }
  }
}

/**
 * Ask the ICE adapter for its peers every two seconds while `active`: in a
 * game, and with something on screen to show them. Shared with the status
 * bar's connection check (#647).
 */
export function useLiveRelayPolling(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const ask = () => ipc.send({ kind: "Connectivity", command: { type: "refreshRelayStatus" } });
    ask();
    const timer = window.setInterval(ask, RELAY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active]);
}

/** The run button's words for where the check is. */
export function checkRunLabel(check: ConnectivityCheck, t: Translate): string {
  if (check.status.type === "running") return t("settings.connectivityCheck.running");
  if (check.status.type === "finished") return t("settings.connectivityCheck.runAgain");
  return t("settings.connectivityCheck.run");
}

export function runConnectivityCheck() {
  ipc.send({ kind: "Connectivity", command: { type: "runCheck" } });
}

export function ConnectivityDiagnosticsSection() {
  const { t } = useTranslation();
  const check = useAppStore((state) => state.state.connectivity.check);
  const relay = useAppStore((state) => state.state.connectivity.relay);
  const inGame = useAppStore((state) => state.state.lobby.join.type === "inGame");
  const pageOpen = useAppStore((state) => state.state.nav.settingsSection === "connectivity");
  const running = check.status.type === "running";

  useLiveRelayPolling(inGame && pageOpen);

  return (
    <SettingsGroup title={t("settings.section.troubleshooting.title")}>
      <SettingRow label={t("settings.connectivityCheck.label")}>
        <Button onClick={runConnectivityCheck} disabled={running}>
          {checkRunLabel(check, t)}
        </Button>
      </SettingRow>
      {check.status.type !== "idle" && <CheckResults check={check} />}
      <SettingRow label={t("settings.liveRelay.label")} hint={t("settings.liveRelay.hint")}>
        {!inGame && <span className="muted">{t("settings.liveRelay.noGame")}</span>}
      </SettingRow>
      {inGame && <LiveRelay relay={relay} />}
    </SettingsGroup>
  );
}
