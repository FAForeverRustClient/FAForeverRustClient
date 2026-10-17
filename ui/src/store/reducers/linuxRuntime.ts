// Mirrors crates/faf-domain/src/state/linux_runtime.rs.

import type { LinuxRuntimeEvent, LinuxRuntimeState } from "../../ipc/bindings";

export function reduceLinuxRuntime(
  state: LinuxRuntimeState,
  event: LinuxRuntimeEvent,
): LinuxRuntimeState {
  switch (event.type) {
    case "statusChanged":
      return { ...state, status: event.payload.status };
  }
}
