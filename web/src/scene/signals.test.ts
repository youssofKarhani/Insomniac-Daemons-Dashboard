import { describe, expect, it } from "vitest";
import type { DashboardEvent } from "../model/events";
import { reduceAll } from "../model/reduce";
import { initialState } from "../model/state";
import { signalArrival } from "./signals";
import { SignalWorld, signalEvents } from "./signalWorld";

const event = (kind: DashboardEvent["kind"], data: DashboardEvent["data"], ts = 1000, id: string = kind): DashboardEvent =>
  ({ id, kind, data, ts, confidence: "observed" });

describe("signal arrival timing", () => {
  it.each([
    event("guard.latch", { locked: false }),
    event("cp.state", { state: "pending" }),
    event("keda.scale", { replicas: 1 }),
    event("ebs.attached", { attached: true }),
    event("node.joined", { joined: true }),
    event("ssm.session", { open: true }),
  ])("holds $kind until its signal arrives, including after seeking backward", (e) => {
    const history = [e];
    const base = reduceAll(history, initialState());
    const visual = new SignalWorld();
    const arrival = signalArrival(e);
    const fields = (w: ReturnType<SignalWorld["at"]>) => [w.guardLocked, w.cp.state, w.keda.replicas, w.gpu.ebsAttached, w.gpu.joined, w.ssmOpen];
    expect(arrival).toBeGreaterThan(e.ts);
    expect(fields(visual.at(base, history, arrival - 1))).toEqual(fields(initialState()));
    expect(fields(visual.at(base, history, arrival))).toEqual(fields(base));
    expect(fields(visual.at(base, history, e.ts))).toEqual(fields(initialState()));
  });

  it("keeps rapidly reversed guard commands in source order", () => {
    const events = [event("guard.latch", { locked: true }, 1000, "z"), event("guard.latch", { locked: false }, 1001, "a")];
    const scheduled = signalEvents(events);
    expect(scheduled[1].ts).toBeGreaterThan(scheduled[0].ts);
    const base = reduceAll(events, initialState());
    expect(new SignalWorld().at(base, events, scheduled[1].ts + 1).guardLocked).toBe(false);
  });

  it("waits for ingress before flashing the wake switch", () => {
    const ingress = event("ingress.prewarm", {});
    const invoke = event("lambda.invoked", {}, 1100);
    const events = [ingress, invoke];
    const visual = new SignalWorld();
    const base = reduceAll(events, initialState());
    expect(visual.at(base, events, signalArrival(ingress) - 1).pulses.lambda).toBeUndefined();
    expect(visual.at(base, events, signalArrival(ingress)).pulses.lambda).toBe(signalArrival(ingress));
  });
});

