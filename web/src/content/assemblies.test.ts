import { describe, expect, it } from "vitest";
import { ASSEMBLIES } from "./assemblies";
import { OBJECT_IDS } from "./components";
import { initialState } from "../model/state";

const all = Object.values(ASSEMBLIES);

describe("teardown assemblies", () => {
  it("belong to scene objects", () => {
    for (const a of all) expect(OBJECT_IDS).toContain(a.id);
  });

  it("give every part a unique id and a known group", () => {
    for (const a of all) {
      const groups = new Set(a.groups.map((g) => g.id));
      const ids = new Set<string>();
      for (const p of a.parts) {
        expect(groups.has(p.group), `${a.id}/${p.id} group`).toBe(true);
        expect(ids.has(p.id), `${a.id}/${p.id} duplicate`).toBe(false);
        ids.add(p.id);
      }
      // Every group has at least one part to show.
      for (const g of groups) expect(a.parts.some((p) => p.group === g), `${a.id}/${g} empty`).toBe(true);
    }
  });

  it("read the world without throwing, at rest", () => {
    const w = initialState(0);
    for (const a of all) {
      expect(a.readouts(w).length).toBeGreaterThan(0);
      a.groups.forEach((g) => g.status(w));
      for (const p of a.parts) {
        const v = p.active?.(w) ?? 0;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("contain nothing the public site must not show", () => {
    const text = JSON.stringify(all.map((a) => ({ ...a, parts: a.parts.map((p) => [p.name, p.spec, p.detail]) })));
    expect(text).not.toMatch(/arn:aws/i);
    expect(text).not.toMatch(/\b\d{12}\b/);
    expect(text).not.toMatch(/\b(i|vol|subnet|vpc|sg)-[0-9a-f]{6,}\b/);
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/execute-api|amazonaws\.com/);
  });
});
