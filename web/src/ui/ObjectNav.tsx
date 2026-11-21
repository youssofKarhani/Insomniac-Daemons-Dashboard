import { OBJECT_IDS, OBJECTS } from "../content/components";
import { useDashboard } from "../store";

/** Keyboard route through every object, in the order work flows. Visible only while focused. */
export function ObjectNav() {
  const select = useDashboard((s) => s.select);
  const selected = useDashboard((s) => s.selected);
  return (
    <nav className="object-nav" aria-label="Components">
      <span className="eyebrow">Components</span>
      <ul>
        {OBJECT_IDS.map((id) => (
          <li key={id}>
            <button aria-current={selected === id} onFocus={() => select(id)} onClick={() => select(id)}>
              {OBJECTS[id].name}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
