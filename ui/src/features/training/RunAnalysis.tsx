// A recorded build order, in the three views that answer different questions.
//
// The written order says what to do. The flow says when each of those things
// actually happened, in one run. The map says where. Side by side they answer
// the question a text build order cannot: "and where was the engineer while
// that was building?"
//
// The two drawn panes share one hover. Pointing at an engineer's lane in the
// flow lights the route it drove on the map, and pointing at a route lights its
// lane. That pairing is the reason they sit next to each other rather than in
// tabs, and it is why the hover state lives here rather than in either of them.

import { useMemo, useState, type ReactNode } from "react";

import { useTranslation } from "../../i18n/useTranslation";
import { BuildFlow } from "./BuildFlow";
import { RunMap } from "./RunMap";
import { mmss, runStalls, toLanes, type Envelope } from "./recording";

interface Props {
  env: Envelope;
  /** The written build order, when the entry also carries one. */
  prose: ReactNode;
  /** The map's real preview art, resolved from the vault. */
  previewUrl: string;
}

export function RunAnalysis({ env, prose, previewUrl }: Props) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<string | null>(null);
  // A hover names an entity of one run. The next run can reuse the id for a
  // different unit, so it starts with nothing highlighted.
  const [hoveredRun, setHoveredRun] = useState(env);
  if (hoveredRun !== env) {
    setHoveredRun(env);
    setHovered(null);
  }
  const lanes = useMemo(() => toLanes(env.bo), [env]);
  const stalls = useMemo(() => runStalls(env), [env]);

  return (
    <section className={prose ? "training-run" : "training-run training-run-no-prose"}>
      {prose && <div className="training-run-prose">{prose}</div>}

      <div className="training-run-flow">
        <h4>
          {t("training.run.flow")}
          <span className="muted">{t("training.run.duration", { time: mmss(env.meta.durationMs) })}</span>
        </h4>
        <BuildFlow
          lanes={lanes}
          durationMs={env.meta.durationMs}
          hovered={hovered}
          onHover={setHovered}
          stalls={stalls}
        />
      </div>

      <div className="training-run-side">
        <h4>{t("training.run.map")}</h4>
        <RunMap env={env} previewUrl={previewUrl} hovered={hovered} onHover={setHovered} />
      </div>
    </section>
  );
}
