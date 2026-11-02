import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "../../design-system/Modal";
import { Switch } from "../../design-system/Switch";
import { useTranslation } from "../../i18n/useTranslation";
import { t, type MessageKey } from "../../i18n";
import { native } from "../../ipc/native";
import type { NotificationKind } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { useClockPreference } from "../../shared/format/clock";
import { NotificationCard } from "./NotificationCard";
import { DesktopNotificationCard } from "./DesktopNotificationCard";
import { NotificationRecovery } from "./NotificationRecovery";
import { admitNotifications, deliverNotifications, popupCard, type DeliveryResult } from "./deliverNotifications";
import { RepeatCooldown } from "./notificationGate";
import { playNotificationSound, soundForKind } from "./notificationSound";
import { NOTIFICATION_SAMPLES, sampleEventEnabled, sampleNotification, type TestScenario } from "./notificationSamples";
import "./notificationTests.css";

type Surface = "desktop" | "toast" | "history";
type SampleCard = ReturnType<typeof sampleNotification>;
type Result = (DeliveryResult | { id: string; outcome: "activated" | "dismissed" | "expired" | "error"; detail?: string }) & { label?: string };
const SCENARIOS: TestScenario[] = ["normal", "burst", "long", "missingArt", "repeat"];
const SURFACES: Surface[] = ["desktop", "toast", "history"];
let nextSession = 0;

/** Local fixtures use the real cards; delivery tests use the live delivery runner. */
export function NotificationTestDialog({ onClose }: { onClose: () => void }) {
  useTranslation();
  const use24HourTime = useClockPreference();
  const preferences = useAppStore((store) => store.state.settings.notifications);
  const [kind, setKind] = useState<NotificationKind>("matchFound");
  const [scenario, setScenario] = useState<TestScenario>("normal");
  const [mode, setMode] = useState<"appearance" | "delivery">("appearance");
  const [surface, setSurface] = useState<Surface>("desktop");
  const [hold, setHold] = useState(true);
  const [delay, setDelay] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [hidden, setHidden] = useState<string[]>([]);
  const [read, setRead] = useState<string[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [toasts, setToasts] = useState<SampleCard[]>([]);
  const [session] = useState(() => `preview:${Date.now()}-${++nextSession}`);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tick = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const owned = useRef(new Set<string>());
  const labels = useRef(new Map<string, string>());
  const cooldown = useRef(new RepeatCooldown());
  const report = useCallback((result: Result) => { if (mounted.current) setResults((current) => [...current, { ...result, label: labels.current.get(result.id) }].slice(-60)); }, []);
  const clearTimers = useCallback(() => { clearTimeout(timer.current); clearInterval(tick.current); clearTimeout(watchdog.current); }, []);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const expireOwned = useCallback(() => {
    for (const id of owned.current) void native.notificationPopupInteract(id, "expire").catch(() => undefined);
    owned.current.clear();
    labels.current.clear();
  }, []);
  const cancel = () => { invalidate(); clearTimers(); expireOwned(); setBusy(false); setRemaining(null); setToasts([]); };
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let stop: (() => void) | undefined;
    void native.onNotificationInteraction(({ id, interaction }) => {
      if (!disposed && owned.current.has(id)) report({ id, outcome: interaction === "activate" ? "activated" : interaction === "dismiss" ? "dismissed" : "expired" });
    }).then((unlisten) => { if (!disposed) stop = unlisten; else unlisten(); }).catch(() => undefined);
    return () => { disposed = true; mounted.current = false; invalidate(); clearTimers(); expireOwned(); stop?.(); };
  }, [clearTimers, expireOwned, invalidate, report]);
  const makeSamples = (prefix: string): SampleCard[] => {
    const kinds: NotificationKind[] = scenario === "burst" ? [kind, kind === "privateMessage" ? "newCustomGame" : "privateMessage", "serverWarning"]
      : scenario === "repeat" ? [kind, kind] : [kind];
    return kinds.map((event, index) => sampleNotification(event, `${prefix}:${index}`, scenario));
  };
  const gallery = makeSamples(`gallery-${epoch}`);
  const galleryInteraction = (id: string, interaction: "activate" | "dismiss" | "expire") => {
    report({ id, outcome: interaction === "activate" ? "activated" : interaction === "dismiss" ? "dismissed" : "expired" });
    if (interaction === "activate") setRead((ids) => [...ids, id]); else setHidden((ids) => [...ids, id]);
  };
  const send = () => {
    cancel(); const run = generation.current;
    const samples = makeSamples(`${session}:${++sequence.current}`);
    const valid = () => mounted.current && generation.current === run;
    const runReport = (result: DeliveryResult) => { if (valid()) report(result); };
    setBusy(true); setRemaining(delay || null);
    const execute = async () => {
      clearTimers(); if (!valid()) return;
      setRemaining(null); samples.forEach(({ item }) => { owned.current.add(item.id); labels.current.set(item.id, item.title); });
      const deadline = setTimeout(() => {
        if (!valid()) return;
        report({ id: samples[0].item.id, outcome: "error", detail: t("notifications.test.timeout") });
        cancel();
      }, 10000);
      watchdog.current = deadline;
      try {
        if (mode === "appearance") {
          await native.showNotificationPopup(samples.map(({ item, artwork }) => popupCard(item, artwork)), t("notifications.popup.dismiss"), true, hold);
          if (valid()) samples.forEach(({ item }) => report({ id: item.id, outcome: "desktop" }));
        } else {
          const state = () => useAppStore.getState().state;
          const enabled = samples.filter(({ item }) => {
            if (!state().settings.notifications.enabled) return true;
            if (!sampleEventEnabled(item.kind, state().settings.notifications)) { report({ id: item.id, outcome: "eventDisabled" }); return false; }
            return true;
          });
          const admitted = admitNotifications(enabled.map(({ item }) => item), state(), cooldown.current, () => undefined, runReport);
          await deliverNotifications(admitted, { state, test: true, current: () => valid(), report: runReport,
            artwork: (item) => samples.find((sample) => sample.item.id === item.id)?.artwork ?? null,
            showInside: (items) => { if (valid()) setToasts((current) => [...items.map((item) => ({ item, artwork: samples.find((sample) => sample.item.id === item.id)?.artwork ?? null })), ...current].slice(0, 3)); },
          });
        }
      } catch (reason) { if (valid()) report({ id: samples[0].item.id, outcome: "error", detail: String(reason) }); }
      finally {
        clearTimeout(deadline);
        if (valid()) setBusy(false);
        else for (const { item } of samples) void native.notificationPopupInteract(item.id, "expire").catch(() => undefined);
      }
    };
    if (delay) {
      const due = Date.now() + delay * 1000;
      tick.current = setInterval(() => setRemaining(Math.max(0, Math.ceil((due - Date.now()) / 1000))), 250);
      timer.current = setTimeout(() => void execute(), delay * 1000);
    } else void execute();
  };
  const resetGallery = () => { setEpoch((value) => value + 1); setHidden([]); setRead([]); };
  return <Modal className="notification-test-dialog" ariaLabel={t("notifications.test.title")} onClose={onClose}>
    <h2>{t("notifications.test.title")}</h2><p className="muted">{t("notifications.test.help")}</p>
    <div className="notification-test-controls">
      <label>{t("notifications.test.mode")}<select className="settings-select" value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as typeof mode)}>
        <option value="appearance">{t("notifications.test.appearance")}</option><option value="delivery">{t("notifications.test.delivery")}</option>
      </select></label>
      <label>{t("notifications.test.event")}<select className="settings-select" value={kind} disabled={busy} onChange={(e) => { setKind(e.target.value as NotificationKind); resetGallery(); }}>
        {(Object.keys(NOTIFICATION_SAMPLES) as NotificationKind[]).map((event) => <option key={event} value={event}>{sampleNotification(event, "label").item.title}</option>)}
      </select></label>
      <label>{t("notifications.test.scenario")}<select className="settings-select" value={scenario} disabled={busy} onChange={(e) => { setScenario(e.target.value as TestScenario); resetGallery(); }}>
        {SCENARIOS.map((value) => <option value={value} key={value}>{t(`notifications.test.scenario.${value}`)}</option>)}
      </select></label>
      <label>{t("notifications.test.delay")}<select className="settings-select" value={delay} disabled={busy} onChange={(e) => setDelay(Number(e.target.value))}>
        <option value={0}>{t("notifications.test.now")}</option>{[5, 10].map((seconds) => <option key={seconds} value={seconds}>{t("notifications.test.seconds", { seconds })}</option>)}
      </select></label>
    </div>
    <div className="notification-test-toolbar">
      <Switch label={t("notifications.test.hold")} checked={hold} onChange={(value) => { setHold(value); resetGallery(); }} /><span>{t("notifications.test.hold")}</span>
      <button type="button" className="btn-ghost" onClick={resetGallery}>{t("notifications.test.replay")}</button>
      <button type="button" className="btn-ghost" onClick={() => playNotificationSound(soundForKind(kind, preferences.sounds), preferences.volume)}>{t("notifications.test.sound")}</button>
    </div>
    <div className="notification-test-toolbar">
      <button type="button" className="btn" disabled={busy} onClick={send}>{t(mode === "appearance" ? "notifications.test.showDesktop" : "notifications.test.send")}</button>
      {busy && <button type="button" className="btn-ghost" onClick={cancel}>{t("common.cancel")}</button>}
      {remaining !== null && <span role="status">{t("notifications.test.countdown", { seconds: remaining })}</span>}
    </div>
    <div className="notification-test-surfaces" role="group" aria-label={t("notifications.test.gallery")}>
      {SURFACES.map((value) => <button className="btn-ghost" key={value} type="button" aria-pressed={surface === value} onClick={() => setSurface(value)}>{t(`notifications.test.surface.${value}`)}</button>)}
    </div>
    <div className="notification-test-gallery">
      {gallery.filter(({ item }) => !hidden.includes(item.id)).map(({ item, artwork }) => surface === "desktop"
        ? <DesktopNotificationCard key={`${item.id}-${kind}-${scenario}`} card={popupCard(item, artwork)} dismissLabel={t("notifications.popup.dismiss")}
          duration={hold ? 0 : preferences.toastDurationSeconds * 1000} onInteract={(interaction) => galleryInteraction(item.id, interaction)} />
        : <NotificationCard key={`${item.id}-${surface}-${kind}-${scenario}`} item={{ ...item, read: read.includes(item.id) }} artwork={artwork}
          history={surface === "history"} use24HourTime={use24HourTime} duration={hold ? 0 : preferences.toastDurationSeconds * 1000}
          onActivate={() => galleryInteraction(item.id, "activate")} onDismiss={() => galleryInteraction(item.id, "dismiss")} onExpire={() => galleryInteraction(item.id, "expire")}
          recovery={surface === "history" && item.kind === "error" ? <NotificationRecovery item={item} onPreview={() => galleryInteraction(item.id, "activate")} /> : undefined} />)}
    </div>
    <div className="notification-test-result-head"><h3>{t("notifications.test.results")}</h3>
      <button className="btn-ghost" type="button" onClick={() => { cancel(); setResults([]); setToasts([]); cooldown.current = new RepeatCooldown(); resetGallery(); }}>{t("notifications.test.reset")}</button>
    </div>
    <ul className="notification-test-results" role="log" aria-live="polite">
      {results.length ? results.map((result, index) => <li key={index}>
        {result.label && <strong>{result.label}: </strong>}
        {t(`notifications.test.result.${result.outcome}` as MessageKey)}{result.detail && <span className="muted"> {result.detail}</span>}
      </li>) : <li className="muted">{t("notifications.test.waiting")}</li>}
    </ul>
    {createPortal(<div className={`notification-toasts notification-test-toasts is-${preferences.toastPosition}`} aria-live="polite">
      {toasts.map(({ item, artwork }) => <NotificationCard key={item.id} item={item} artwork={artwork} duration={preferences.toastDurationSeconds * 1000}
        onActivate={() => report({ id: item.id, outcome: "activated" })}
        onDismiss={() => { setToasts((cards) => cards.filter((card) => card.item.id !== item.id)); report({ id: item.id, outcome: "dismissed" }); }}
        onExpire={() => { setToasts((cards) => cards.filter((card) => card.item.id !== item.id)); report({ id: item.id, outcome: "expired" }); }} />)}
    </div>, document.body)}
  </Modal>;
}
