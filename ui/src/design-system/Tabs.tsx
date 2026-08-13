// Tabs primitive — a local (non-backend-routed) segmented control. Reuses the
// top-level TabBar's .tabbar/.tab/.tab-active classes so subtabs (e.g. Play's
// Matchmaker/Custom Games/Co-Op split) look consistent with the main tab bar.

interface TabDef<K extends string> {
  key: K;
  label: string;
}

interface TabsProps<K extends string> {
  tabs: TabDef<K>[];
  active: K;
  onChange: (key: K) => void;
}

export function Tabs<K extends string>({ tabs, active, onChange }: TabsProps<K>) {
  return (
    <nav className="tabbar">
      {tabs.map((t) => (
        <button
          key={t.key}
          className={t.key === active ? "tab tab-active" : "tab"}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
