import { ipc } from "../../ipc/client";
import { StatusNotice } from "../../design-system/StatusNotice";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import {
  PREREQUISITE_KEYS,
  USER_NAMESPACES_COMMAND,
  installCommand,
  linuxRuntimePercent,
  linuxRuntimeStep,
} from "../../shared/linuxRuntimeText";

const prepare = () => ipc.send({ kind: "LinuxRuntime", command: { type: "prepare" } });
const cancel = () => ipc.send({ kind: "LinuxRuntime", command: { type: "cancel" } });

/**
 * The Wine environment the client installs on Linux (`infra::linux_runtime`):
 * where it stands, and what to do when it cannot be installed. Only rendered
 * where the game needs Wine.
 */
export function LinuxRuntimeSettings() {
  const { t } = useTranslation();
  const status = useAppStore((state) => state.state.linuxRuntime.status);
  const ownCommand = useAppStore((state) => (state.state.settings.game.launchWrapper ?? "").trim() !== "");
  const step = linuxRuntimeStep(status, t);
  const percent = linuxRuntimePercent(status);

  return (
    <div className="setting-block">
      <span className="setting-label">{t("settings.game.linuxRuntime.label")}</span>
      <span className="muted">{t("settings.game.linuxRuntime.hint")}</span>

      {status.type === "notNeeded" && ownCommand && (
        <StatusNotice tone="info">{t("settings.game.linuxRuntime.ownCommand")}</StatusNotice>
      )}
      {status.type === "ready" && (
        <StatusNotice tone="info">{t("settings.game.linuxRuntime.ready")}</StatusNotice>
      )}
      {step !== null && (
        <StatusNotice
          tone="busy"
          action={status.type === "checking" ? undefined : { label: t("settings.game.linuxRuntime.cancel"), onClick: cancel }}
        >
          {percent === null ? step : `${step} (${percent}%)`}
        </StatusNotice>
      )}
      {status.type === "failed" && (
        <StatusNotice
          tone="error"
          action={{ label: t("settings.game.linuxRuntime.retry"), onClick: prepare }}
          detail={status.payload.reason}
        >
          {t("settings.game.linuxRuntime.failed", { reason: status.payload.reason })}
        </StatusNotice>
      )}
      {status.type === "missing" && (
        <>
          <StatusNotice
            tone="error"
            action={{ label: t("settings.game.linuxRuntime.check"), onClick: prepare }}
          >
            {t("settings.game.linuxRuntime.missing")}
          </StatusNotice>
          <ul className="linux-runtime-missing">
            {status.payload.prerequisites.map((item) => (
              <li key={item}>{t(PREREQUISITE_KEYS[item])}</li>
            ))}
          </ul>
          <MissingCommands
            distribution={status.payload.distribution}
            prerequisites={status.payload.prerequisites}
          />
        </>
      )}
    </div>
  );
}

function MissingCommands({
  distribution,
  prerequisites,
}: {
  distribution: Parameters<typeof installCommand>[0];
  prerequisites: Parameters<typeof installCommand>[1];
}) {
  const { t } = useTranslation();
  const packages = installCommand(distribution, prerequisites);
  const needsDrivers = prerequisites.includes("vulkan32");
  return (
    <>
      {packages !== null && (
        <>
          <span className="muted">{t("settings.game.linuxRuntime.commandHint")}</span>
          <code className="linux-runtime-command">{packages}</code>
        </>
      )}
      {needsDrivers && <span className="muted">{t("settings.game.linuxRuntime.drivers")}</span>}
      {needsDrivers && distribution === "arch" && (
        <span className="muted">{t("settings.game.linuxRuntime.archMultilib")}</span>
      )}
      {prerequisites.includes("userNamespaces") && (
        <>
          <span className="muted">{t("settings.game.linuxRuntime.userNamespacesHint")}</span>
          <code className="linux-runtime-command">{USER_NAMESPACES_COMMAND}</code>
        </>
      )}
    </>
  );
}
