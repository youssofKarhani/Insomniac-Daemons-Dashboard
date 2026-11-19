import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OBJECT_IDS, OBJECTS } from "../content/components";
import { buildScenario, SCENARIOS } from "../data/scenarios";
import { reduce } from "../model/reduce";
import { initialState, namedPerQueue } from "../model/state";
import { ticketsByLocation } from "../model/tickets";
import { Schematic } from "./Schematic";
import { BOX_H, BOX_W, layout, type Rect } from "./schematicLayout";
import { statusOf } from "./status";

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

describe("2D schematic", () => {
  for (const kind of ["wide", "tall"] as const) {
    it(`${kind} layout places every object once, inside its district, without overlaps`, () => {
      const L = layout(kind);
      expect(Object.keys(L.boxes).sort()).toEqual([...OBJECT_IDS].sort());
      const ids = Object.keys(L.boxes) as (typeof OBJECT_IDS)[number][];
      ids.forEach((a, i) => {
        const d = L.districts.find((x) => x.district.objects.includes(a))!;
        expect(inside(L.boxes[a], d), a).toBe(true);
        ids.slice(i + 1).forEach((b) => expect(overlaps(L.boxes[a], L.boxes[b]), `${a} / ${b}`).toBe(false));
      });
      L.districts.forEach((a, i) => L.districts.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
      expect(L.width).toBeGreaterThanOrEqual(BOX_W);
      expect(L.height).toBeGreaterThanOrEqual(BOX_H);
    });
  }

  it("every object has a short text state at every step of every sample run", () => {
    for (const sc of SCENARIOS) {
      let w = initialState(0);
      for (const e of buildScenario(sc.id)) {
        w = { ...reduce(w, e), t: e.ts };
        for (const id of OBJECT_IDS) {
          const st = statusOf(id, w);
          expect(st.text.length, `${sc.id} ${e.kind} ${id}`).toBeGreaterThan(0);
          expect(st.text.length, st.text).toBeLessThanOrEqual(18);
        }
      }
    }
  });

  it("shows the same tickets the 3D scene draws, without counting a job twice", () => {
    let w = initialState(0);
    for (const e of buildScenario("warm-pair")) w = reduce(w, e);
    // Polled depth that only covers the named jobs adds no unnamed tickets.
    const named = namedPerQueue(w.jobs);
    w = { ...w, queueDepth: { ...w.queueDepth, gpuDlq: { visible: named.gpuDlq + 2, inFlight: 0 } } };
    const t = ticketsByLocation(w.jobs, w.queueDepth);
    expect(t.get("gpuDlq")?.length).toBe(named.gpuDlq + 2);
    expect(statusOf("gpuDlq", w, t)).toEqual({ tone: "fail", text: `${named.gpuDlq + 2} dead letters` });
  });

  it("marks inferred states in text, not only by the dashed outline", () => {
    let w = initialState(0);
    for (const e of buildScenario("cold-gpu")) {
      w = reduce(w, e);
      if (e.kind === "vllm.state" && e.data.state === "ready") break;
    }
    expect(statusOf("vllm", w)).toMatchObject({ text: "Ready", inferred: true });
    expect(statusOf("gpuNode", w)).toMatchObject({ tone: "busy", text: "Running" });
  });

  it("renders a labelled, keyboard-reachable box for every object", () => {
    for (const tall of [false, true]) {
      const html = renderToStaticMarkup(createElement(Schematic, { tall }));
      for (const id of OBJECT_IDS) {
        expect(html).toContain(`data-id="${id}"`);
        expect(html).toContain(`aria-label="${OBJECTS[id].name}: `);
      }
      expect(html.match(/role="button"/g)?.length).toBe(OBJECT_IDS.length);
      expect(html.match(/tabindex="0"/g)?.length).toBe(OBJECT_IDS.length);
    }
  });
});
