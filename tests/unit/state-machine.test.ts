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

describe("ミッション状態機械", () => {
  it("正常系と評価・再計画ループを許可する", () => {
    assert.equal(canTransitionMission("created", "planning"), true);
    assert.equal(canTransitionMission("planning", "executing"), true);
    assert.equal(canTransitionMission("executing", "evaluating"), true);
    assert.equal(canTransitionMission("evaluating", "replanning"), true);
    assert.equal(canTransitionMission("replanning", "executing"), true);
    assert.equal(canTransitionMission("evaluating", "completed"), true);
  });

  it("明示的なブロック状態とエスカレーション状態からの復旧をサポートする", () => {
    assert.equal(canTransitionMission("executing", "blocked"), true);
    assert.equal(canTransitionMission("blocked", "escalated"), true);
    assert.equal(canTransitionMission("escalated", "executing"), true);
  });

  it("終端状態を終端のままにし、不正な状態遷移を拒否する", () => {
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

describe("タスク状態機械", () => {
  it("実行、評価、再試行、完了を許可する", () => {
    assert.equal(canTransitionTask("pending", "running"), true);
    assert.equal(canTransitionTask("running", "evaluating"), true);
    assert.equal(canTransitionTask("evaluating", "pending"), true);
    assert.equal(canTransitionTask("evaluating", "completed"), true);
  });

  it("終端状態を終端のままにし、完了状態から実行中への遷移を拒否する", () => {
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
