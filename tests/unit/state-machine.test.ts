import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InvalidStateTransitionError,
  assertMissionTransition,
  assertTaskTransition,
  canTransitionMission,
  canTransitionTask,
  missionTransitionMap,
  taskTransitionMap,
} from "../../src/runtime/state-machine.js";

describe("mission state machine", () => {
  it("allows the happy path and the evaluation/replan loop", () => {
    assert.equal(canTransitionMission("created", "planning"), true);
    assert.equal(canTransitionMission("planning", "executing"), true);
    assert.equal(canTransitionMission("executing", "evaluating"), true);
    assert.equal(canTransitionMission("evaluating", "replanning"), true);
    assert.equal(canTransitionMission("replanning", "executing"), true);
    assert.equal(canTransitionMission("evaluating", "completed"), true);
  });

  it("supports recovery from explicit blocked and escalated states", () => {
    assert.equal(canTransitionMission("executing", "blocked"), true);
    assert.equal(canTransitionMission("blocked", "escalated"), true);
    assert.equal(canTransitionMission("escalated", "executing"), true);
  });

  it("makes terminal states terminal and rejects illegal transitions", () => {
    assert.deepEqual(missionTransitionMap.completed, []);
    assert.deepEqual(missionTransitionMap.failed, []);
    assert.deepEqual(missionTransitionMap.cancelled, []);

    assert.throws(
      () => assertMissionTransition("completed", "executing"),
      (error: unknown) =>
        error instanceof InvalidStateTransitionError &&
        error.entity === "mission" &&
        error.from === "completed" &&
        error.to === "executing",
    );
  });
});

describe("task state machine", () => {
  it("allows execution, evaluation, retry, and completion", () => {
    assert.equal(canTransitionTask("pending", "running"), true);
    assert.equal(canTransitionTask("running", "evaluating"), true);
    assert.equal(canTransitionTask("evaluating", "pending"), true);
    assert.equal(canTransitionTask("evaluating", "completed"), true);
  });

  it("makes terminal states terminal and rejects completed to running", () => {
    assert.deepEqual(taskTransitionMap.completed, []);
    assert.deepEqual(taskTransitionMap.failed, []);
    assert.deepEqual(taskTransitionMap.cancelled, []);

    assert.throws(
      () => assertTaskTransition("completed", "running"),
      (error: unknown) =>
        error instanceof InvalidStateTransitionError &&
        error.entity === "task" &&
        error.from === "completed" &&
        error.to === "running",
    );
  });
});
