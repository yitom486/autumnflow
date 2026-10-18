// @vitest-environment node
/**
 * Background residency is a lifecycle policy, so it is tested as a pure state
 * machine: no Electron, no timers, just a clock the test owns.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BackgroundKeeper,
  DEFAULT_BACKGROUND_SETTINGS,
  readBackgroundSettings,
  writeBackgroundSettings,
} from "../../desktop/background-policy";

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("background settings file", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "autumnflow-bg-"));
  });

  it("defaults to enabled with a 30 minute idle exit", () => {
    expect(readBackgroundSettings(dir)).toEqual(DEFAULT_BACKGROUND_SETTINGS);
    expect(readBackgroundSettings(dir)).toEqual({ enabled: true, idleExitMinutes: 30 });
  });

  it("round-trips and clamps invalid values", () => {
    writeBackgroundSettings(dir, { enabled: false, idleExitMinutes: 5 });
    expect(readBackgroundSettings(dir)).toEqual({ enabled: false, idleExitMinutes: 5 });

    fs.writeFileSync(path.join(dir, "background.json"), JSON.stringify({ enabled: "yes", idleExitMinutes: -3 }));
    expect(readBackgroundSettings(dir)).toEqual({ enabled: true, idleExitMinutes: 30 });

    fs.writeFileSync(path.join(dir, "background.json"), "{not json");
    expect(readBackgroundSettings(dir)).toEqual(DEFAULT_BACKGROUND_SETTINGS);
  });
});

describe("BackgroundKeeper", () => {
  let time: ReturnType<typeof clock>;
  let notifications: number;
  let exits: number;
  const make = (idleExitMinutes = 30) =>
    new BackgroundKeeper({
      settings: { enabled: true, idleExitMinutes },
      now: time.now,
      onAllWorkDone: () => {
        notifications += 1;
      },
      onIdleExit: () => {
        exits += 1;
      },
    });

  beforeEach(() => {
    time = clock();
    notifications = 0;
    exits = 0;
  });

  it("does not keep the app alive when the window closes with no work", () => {
    const keeper = make();
    keeper.begin();
    expect(keeper.markWork(0)).toBe(false);
    expect(notifications).toBe(0);
    expect(exits).toBe(0);
  });

  it("keeps running while work is in flight, then notifies once it is done", () => {
    const keeper = make();
    keeper.begin();
    time.advance(1000);
    expect(keeper.markWork(3)).toBe(true);
    expect(keeper.idleMiss).toBeNull();

    time.advance(4000);
    expect(keeper.markWork(0)).toBe(true);
    expect(notifications).toBe(1);
    expect(keeper.notified).toBe(true);
    expect(keeper.idleMiss).toBe(0);

    // Still idle: no duplicate notification.
    time.advance(4000);
    keeper.markWork(0);
    expect(notifications).toBe(1);
  });

  it("exits after the idle window, and restarts the window when work resumes", () => {
    const keeper = make(1); // 1 minute
    keeper.begin();
    keeper.markWork(1);

    time.advance(20_000);
    keeper.markWork(0);
    expect(exits).toBe(0);

    time.advance(59_000);
    keeper.markWork(0);
    expect(exits).toBe(0);

    time.advance(1_000);
    keeper.markWork(0);
    expect(exits).toBe(1);

    // A new burst of work clears the idle clock and re-arms the notification.
    time.advance(1_000);
    keeper.markWork(2);
    expect(keeper.idleMiss).toBeNull();
    time.advance(1_000);
    keeper.markWork(0);
    expect(notifications).toBe(2);
    expect(exits).toBe(1);
  });

  it("never auto-exits when the idle limit is 0", () => {
    const keeper = make(0);
    keeper.begin();
    keeper.markWork(1);
    time.advance(24 * 60 * 60_000);
    keeper.markWork(0);
    expect(exits).toBe(0);
  });

  it("restarts the idle clock when the limit is changed", () => {
    const keeper = make(1);
    keeper.begin();
    keeper.markWork(1);
    time.advance(30_000);
    keeper.markWork(0);

    keeper.updateSettings({ enabled: true, idleExitMinutes: 5 });
    expect(keeper.idleMiss).toBe(0);
    time.advance(65_000);
    keeper.markWork(0);
    expect(exits).toBe(0);
  });

  it("stops tracking when a window comes back", () => {
    const keeper = make(1);
    keeper.begin();
    keeper.markWork(1);
    keeper.end();
    expect(keeper.idleMiss).toBeNull();
  });
});
