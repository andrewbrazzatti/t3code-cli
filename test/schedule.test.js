import assert from "node:assert/strict";
import test from "node:test";

test("durations parse into milliseconds and reject garbage", async () => {
  const { parseDurationMs } = await import("../dist/schedule.js");
  assert.equal(parseDurationMs("90m"), 90 * 60 * 1000);
  assert.equal(parseDurationMs("2h30m"), 150 * 60 * 1000);
  assert.equal(parseDurationMs("1d12h"), 36 * 60 * 60 * 1000);
  assert.equal(parseDurationMs("45s"), 45 * 1000);

  const invalid = ["", "2", "2x", "m", "1h30", "1.5h", "-5m"];
  for (const value of invalid) {
    assert.throws(() => parseDurationMs(value), (error) => error.code === "cli_parse_failed", `expected "${value}" to be rejected`);
  }
  assert.throws(() => parseDurationMs("0m"), (error) => error.code === "cli_parse_failed");
});

test("schedule triggers map to server interval, fixed_time, and webhook shapes", async () => {
  const { parseScheduleTrigger } = await import("../dist/schedule.js");

  assert.deepEqual(parseScheduleTrigger({ every: "2h30m" }), { type: "interval", everyMs: 150 * 60 * 1000 });
  assert.deepEqual(parseScheduleTrigger({ at: "9:30" }), { type: "fixed_time", timeOfDay: "09:30" });
  assert.deepEqual(parseScheduleTrigger({ at: "18:00", weekdays: "mon,wed,5" }), { type: "fixed_time", timeOfDay: "18:00", weekdays: [1, 3, 5] });
  assert.deepEqual(parseScheduleTrigger({ webhook: true }), { type: "webhook" });

  // Exactly one trigger is required.
  for (const flags of [{}, { every: "5m", at: "09:00" }, { at: "09:00", webhook: true }, { every: "5m", webhook: true }]) {
    assert.throws(() => parseScheduleTrigger(flags), (error) => error.code === "cli_parse_failed", `expected ${JSON.stringify(flags)} to be rejected`);
  }
  // Interval minimum is one minute (the server's floor).
  assert.throws(() => parseScheduleTrigger({ every: "30s" }), (error) => error.code === "cli_parse_failed");
  // Invalid wall-clock times.
  assert.throws(() => parseScheduleTrigger({ at: "25:00" }), (error) => error.code === "cli_parse_failed");
  assert.throws(() => parseScheduleTrigger({ at: "9:75" }), (error) => error.code === "cli_parse_failed");
  // --weekdays only applies to --at.
  assert.throws(() => parseScheduleTrigger({ every: "5m", weekdays: "mon" }), (error) => error.code === "cli_parse_failed");
  assert.throws(() => parseScheduleTrigger({ webhook: true, weekdays: "mon" }), (error) => error.code === "cli_parse_failed");
});

test("weekday parsing accepts numbers and names and rejects unknown days", async () => {
  const { parseWeekdays } = await import("../dist/schedule.js");
  assert.deepEqual(parseWeekdays("1,2,3"), [1, 2, 3]);
  assert.deepEqual(parseWeekdays("fri,mon"), [1, 5]);
  assert.deepEqual(parseWeekdays("0,6,0"), [0, 6]);
  assert.throws(() => parseWeekdays("funday"), (error) => error.code === "cli_parse_failed");
  assert.throws(() => parseWeekdays("7"), (error) => error.code === "cli_parse_failed");
  assert.throws(() => parseWeekdays(""), (error) => error.code === "cli_parse_failed");
});
