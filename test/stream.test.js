import assert from "node:assert/strict";
import test from "node:test";

test("thread stream normalization distinguishes synchronization, snapshots, events, and malformed items", async () => {
  const { normalizeThreadStreamItem, terminalStateFrom } = await import("../dist/app.js");
  assert.equal(normalizeThreadStreamItem("thread-1", { kind: "synchronized" }).type, "thread.synchronized");
  const snapshot = normalizeThreadStreamItem("thread-1", { kind: "snapshot", snapshotSequence: 3, projection: { thread: { id: "thread-1" } } });
  assert.equal(snapshot.type, "thread.snapshot");
  assert.equal(snapshot.snapshotSequence, 3);
  assert.equal(snapshot.thread.id, "thread-1");
  assert.equal(normalizeThreadStreamItem("thread-1", { kind: "event", event: { type: "run.updated" } }).type, "thread.event");
  assert.equal(normalizeThreadStreamItem("thread-1", { unexpected: true }).type, "thread.malformed_event");

  assert.equal(terminalStateFrom({ projection: { runs: [{ ordinal: 1, status: "completed" }], runtimeRequests: [] } }), "completed");
  assert.equal(terminalStateFrom({ projection: { runs: [{ ordinal: 1, status: "running" }], runtimeRequests: [{ status: "pending" }] } }), "approval_required");
  assert.equal(terminalStateFrom({ projection: { runs: [{ ordinal: 1, status: "running" }], runtimeRequests: [] } }), undefined);
  assert.equal(terminalStateFrom({ event: { type: "run.updated", payload: { status: "failed" } } }), "failed");
  assert.equal(terminalStateFrom({ event: { type: "run.updated", payload: { status: "interrupted" } } }), "interrupted");
  assert.equal(terminalStateFrom({ event: { type: "runtime-request.updated", payload: { status: "pending" } } }), "approval_required");
});
