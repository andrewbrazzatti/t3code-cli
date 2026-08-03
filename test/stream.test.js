import assert from "node:assert/strict";
import test from "node:test";

test("thread stream normalization distinguishes synchronization, snapshots, events, and malformed items", async () => {
  const { normalizeThreadStreamItem, terminalStateFrom } = await import("../dist/app.js");
  assert.equal(normalizeThreadStreamItem("thread-1", { kind: "synchronized" }).type, "thread.synchronized");
  assert.equal(normalizeThreadStreamItem("thread-1", { kind: "snapshot", snapshot: { thread: {} } }).type, "thread.snapshot");
  assert.equal(normalizeThreadStreamItem("thread-1", { kind: "event", event: { type: "thread.activity-appended" } }).type, "thread.event");
  assert.equal(normalizeThreadStreamItem("thread-1", { unexpected: true }).type, "thread.malformed_event");
  assert.equal(terminalStateFrom({ thread: { latestTurn: { state: "completed" } } }), "completed");
  assert.equal(terminalStateFrom({ event: { payload: { activity: { kind: "approval.requested" } } } }), "approval_required");
  assert.equal(terminalStateFrom({ event: { payload: { activity: { kind: "turn.aborted" } } } }), "interrupted");
});
