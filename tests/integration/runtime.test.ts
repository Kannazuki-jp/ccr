import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  DEFAULT_MISSION_PROPOSAL,
  DEFAULT_TASK_PLAN,
  createMockAgents,
} from "../../src/agents/mock-agents.js";
import type { RuntimeAgents } from "../../src/agents/interfaces.js";
import type {
  EvaluationProposal,
  Event,
} from "../../src/domain/index.js";
import {
  LlmCommanderAgent,
  LlmEvaluatorAgent,
  LlmLeadAgent,
  LlmWorkerAgent,
} from "../../src/llm/agents.js";
import type {
  StructuredLlmProvider,
  StructuredLlmRequest,
} from "../../src/llm/provider.js";
import { CommandControlRuntime } from "../../src/runtime/runtime.js";
import { SqliteStore } from "../../src/storage/sqlite/sqlite-store.js";

function eventTaskId(event: Event): string | undefined {
  if (
    typeof event.payload !== "object" ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    return undefined;
  }
  const taskId = event.payload.taskId;
  return typeof taskId === "string" ? taskId : undefined;
}

function eventIndex(events: readonly Event[], type: string, startAt = 0): number {
  const offset = events.slice(startAt).findIndex((event) => event.type === type);
  return offset === -1 ? -1 : startAt + offset;
}

function assertOrdered(values: readonly number[]): void {
  for (const [index, value] of values.entries()) {
    assert.ok(value >= 0, `expected event at sequence position ${index}`);
    if (index > 0) {
      assert.ok(
        value > (values[index - 1] as number),
        `expected ${String(value)} to follow ${String(values[index - 1])}`,
      );
    }
  }
}

describe("コマンド＆コントロール・ランタイムの統合テスト", () => {
  it("依存関係と指揮統制ルーティングの順序に従う3タスクの正常系を完了する", async () => {
    const store = new SqliteStore();
    const agents = createMockAgents({ scenario: "happy" });
    try {
      const runtime = new CommandControlRuntime(store, agents);
      const result = await runtime.run({ goal: "Add completed todo endpoint" });

      assert.equal(result.status, "completed");
      assert.equal(result.finalResult, "Mission completed after all active tasks passed evaluation");
      assert.equal(result.currentTask, undefined);
      assert.equal(result.tasks.length, 3);
      assert.ok(result.tasks.every((task) => task.status === "completed"));
      assert.equal(result.reports.length, 3);
      assert.equal(result.decisions.length, 0);

      const executionOrder = agents.worker.calls.map(({ task }) => task.objective);
      assert.deepEqual(
        executionOrder,
        DEFAULT_TASK_PLAN.map(({ objective }) => objective),
      );
      const executedTasks = agents.worker.calls.map(({ task }) => task);
      assert.deepEqual(executedTasks[0]?.dependencies, []);
      assert.deepEqual(executedTasks[1]?.dependencies, [executedTasks[0]?.id]);
      assert.deepEqual(executedTasks[2]?.dependencies, [executedTasks[1]?.id]);

      assert.deepEqual(
        agents.trace.entries.map(({ operation }) => operation),
        [
          "createMission",
          "plan",
          "execute",
          "evaluate",
          "execute",
          "evaluate",
          "execute",
          "evaluate",
        ],
      );
      assert.deepEqual(
        result.events
          .filter(({ type }) => type === "TaskStarted")
          .map(eventTaskId),
        executedTasks.map(({ id }) => id),
      );
      assert.deepEqual(
        result.events
          .filter(({ type }) => type === "TaskCompleted")
          .map(eventTaskId),
        executedTasks.map(({ id }) => id),
      );
      assert.equal(result.events.at(-1)?.type, "MissionCompleted");

      const durable = store.loadMissionSnapshot(result.mission.id);
      assert.equal(durable?.mission.status, "completed");
      assert.equal(durable?.tasks.length, 3);
      assert.equal(durable?.reports.length, 3);
      assert.equal(durable?.events.at(-1)?.type, "MissionCompleted");
    } finally {
      store.close();
    }
  });

  it("同じタスクを1回再試行し、両方のレポートを保持してから完了する", async () => {
    const store = new SqliteStore();
    const agents = createMockAgents({ scenario: "retry" });
    try {
      const result = await new CommandControlRuntime(store, agents).run({
        goal: "Exercise retry control flow",
      });

      assert.equal(result.status, "completed");
      assert.equal(agents.worker.callCount, 4);
      assert.equal(agents.evaluator.callCount, 4);
      assert.equal(agents.lead.replanCallCount, 0);
      assert.equal(agents.worker.calls[0]?.task.id, agents.worker.calls[1]?.task.id);

      const retriedTaskId = agents.worker.calls[0]?.task.id;
      assert.ok(retriedTaskId !== undefined);
      assert.deepEqual(
        result.reports
          .filter(({ taskId }) => taskId === retriedTaskId)
          .map(({ attempt }) => attempt),
        [1, 2],
      );
      assert.deepEqual(result.decisions.map(({ decision }) => decision), ["retry"]);

      const failed = eventIndex(result.events, "EvaluationFailed");
      const decision = eventIndex(result.events, "DecisionMade", failed + 1);
      const scheduled = eventIndex(result.events, "TaskRetryScheduled", decision + 1);
      const secondStart = result.events.findIndex(
        (event, index) =>
          index > scheduled &&
          event.type === "TaskStarted" &&
          eventTaskId(event) === retriedTaskId,
      );
      const passed = eventIndex(result.events, "EvaluationPassed", secondStart + 1);
      assertOrdered([failed, decision, scheduled, secondStart, passed]);
      assert.equal(
        result.events.some(({ type }) => type === "MissionReplanned"),
        false,
      );
    } finally {
      store.close();
    }
  });

  it("失敗した作業を再計画し、置き換えられた保留中のタスクをキャンセルして代替タスクを完了する", async () => {
    const store = new SqliteStore();
    const agents = createMockAgents({ scenario: "replan" });
    try {
      const result = await new CommandControlRuntime(store, agents).run({
        goal: "Exercise replan control flow",
      });

      assert.equal(result.status, "completed");
      assert.equal(agents.lead.replanCallCount, 1);
      assert.equal(agents.worker.callCount, 2);
      assert.deepEqual(
        agents.worker.calls.map(({ task }) => task.objective),
        [
          DEFAULT_TASK_PLAN[0]?.objective,
          "Correct the cause identified by the failed evaluation",
        ],
      );
      assert.equal(agents.lead.replanCalls[0]?.context.evaluation.recommendation, "replan");
      assert.equal(agents.lead.replanCalls[0]?.context.reports.length, 1);
      assert.deepEqual(result.decisions.map(({ decision }) => decision), ["replan"]);
      assert.equal(result.tasks.filter(({ status }) => status === "failed").length, 1);
      assert.equal(result.tasks.filter(({ status }) => status === "cancelled").length, 2);
      assert.equal(result.tasks.filter(({ status }) => status === "completed").length, 1);

      const failed = eventIndex(result.events, "EvaluationFailed");
      const decision = eventIndex(result.events, "DecisionMade", failed + 1);
      const replanning = eventIndex(result.events, "MissionReplanningStarted", decision + 1);
      const replanned = eventIndex(result.events, "MissionReplanned", replanning + 1);
      const replacementCreated = eventIndex(result.events, "TaskCreated", replanned + 1);
      const replacementStarted = eventIndex(result.events, "TaskStarted", replacementCreated + 1);
      assertOrdered([
        failed,
        decision,
        replanning,
        replanned,
        replacementCreated,
        replacementStarted,
      ]);
    } finally {
      store.close();
    }
  });

  it("評価者を呼び出さずにワーカーのエスカレーションをルーティングする", async () => {
    const store = new SqliteStore();
    const agents = createMockAgents({ scenario: "escalation" });
    try {
      const result = await new CommandControlRuntime(store, agents).run({
        goal: "Request an operation outside Worker authority",
      });

      assert.equal(result.status, "escalated");
      assert.equal(result.escalation?.required, true);
      assert.match(result.escalation?.reason ?? "", /approval is required/i);
      assert.equal(agents.worker.callCount, 1);
      assert.equal(agents.evaluator.callCount, 0);
      assert.equal(agents.lead.replanCallCount, 0);
      assert.equal(result.reports[0]?.status, "blocked");
      assert.equal(result.currentTask?.status, "blocked");
      assert.deepEqual(result.decisions.map(({ decision }) => decision), ["escalate"]);
      assert.ok(result.events.some(({ type }) => type === "TaskBlocked"));
      assert.equal(result.events.at(-1)?.type, "EscalationRequested");
      assert.equal(result.events.some(({ type }) => type === "TaskCompleted"), false);
      assert.equal(result.events.some(({ type }) => type === "MissionCompleted"), false);
    } finally {
      store.close();
    }
  });

  it("ワーカーの成功レポートを保存した後に評価者のエスカレーションをルーティングする", async () => {
    const escalation: EvaluationProposal = {
      result: "fail",
      reasons: ["A Commander decision is required"],
      recommendation: "escalate",
    };
    const store = new SqliteStore();
    const agents = createMockAgents({
      evaluator: { evaluations: [escalation] },
    });
    try {
      const result = await new CommandControlRuntime(store, agents).run({
        goal: "Escalate an evaluation decision",
      });

      assert.equal(result.status, "escalated");
      assert.equal(agents.worker.callCount, 1);
      assert.equal(agents.evaluator.callCount, 1);
      assert.equal(agents.lead.replanCallCount, 0);
      assert.equal(result.reports[0]?.status, "success");
      assert.equal(result.currentTask?.status, "blocked");
      assert.deepEqual(result.decisions.map(({ decision }) => decision), ["escalate"]);

      const submitted = eventIndex(result.events, "ReportSubmitted");
      const failed = eventIndex(result.events, "EvaluationFailed", submitted + 1);
      const decision = eventIndex(result.events, "DecisionMade", failed + 1);
      const escalated = eventIndex(result.events, "EscalationRequested", decision + 1);
      assertOrdered([submitted, failed, decision, escalated]);
      assert.equal(result.events.some(({ type }) => type === "MissionReplanned"), false);
    } finally {
      store.close();
    }
  });

  it("回復不能な評価失敗を完了イベントなしの終端状態にする", async () => {
    const store = new SqliteStore();
    const agents = createMockAgents({ scenario: "terminal-fail" });
    try {
      const result = await new CommandControlRuntime(store, agents).run({
        goal: "Exercise terminal failure",
      });

      assert.equal(result.status, "failed");
      assert.equal(result.finalResult, "Mission failed");
      assert.equal(agents.worker.callCount, 1);
      assert.equal(agents.evaluator.callCount, 1);
      assert.deepEqual(result.decisions.map(({ decision }) => decision), ["fail"]);
      assert.equal(result.tasks.filter(({ status }) => status === "failed").length, 1);
      assert.equal(result.tasks.filter(({ status }) => status === "cancelled").length, 2);
      assert.equal(result.tasks.some(({ status }) => status === "pending"), false);
      const taskFailed = eventIndex(result.events, "TaskFailed");
      const firstCancellation = eventIndex(result.events, "TaskCancelled", taskFailed + 1);
      const missionFailed = eventIndex(result.events, "MissionFailed", firstCancellation + 1);
      assertOrdered([taskFailed, firstCancellation, missionFailed]);
      assert.equal(result.events.at(-1)?.type, "MissionFailed");
      assert.equal(result.events.some(({ type }) => type === "TaskCompleted"), false);
      assert.equal(result.events.some(({ type }) => type === "MissionCompleted"), false);
    } finally {
      store.close();
    }
  });

  it("無効な評価者出力を完了前に明示的な永続化失敗へ変換する", async () => {
    const invalidEvaluation = {
      result: "pass",
      reasons: [],
      recommendation: "retry",
    } as unknown as EvaluationProposal;
    const store = new SqliteStore();
    const agents = createMockAgents({
      evaluator: { evaluations: [invalidEvaluation] },
    });
    try {
      const result = await new CommandControlRuntime(store, agents).run({
        goal: "Reject invalid structured output",
      });

      assert.equal(result.status, "failed");
      assert.equal(result.tasks.filter(({ status }) => status === "failed").length, 1);
      assert.equal(result.tasks.filter(({ status }) => status === "cancelled").length, 2);
      const rejected = eventIndex(result.events, "StructuredOutputRejected");
      const taskFailed = eventIndex(result.events, "TaskFailed", rejected + 1);
      const missionFailed = eventIndex(result.events, "MissionFailed", taskFailed + 1);
      assertOrdered([rejected, taskFailed, missionFailed]);
      assert.equal(result.events.at(-1)?.type, "MissionFailed");
      assert.equal(result.events.some(({ type }) => type === "EvaluationPassed"), false);
      assert.equal(result.events.some(({ type }) => type === "TaskCompleted"), false);
      assert.equal(result.events.some(({ type }) => type === "MissionCompleted"), false);
      assert.equal(agents.evaluator.callCount, 1);

      const durable = store.loadMissionSnapshot(result.mission.id);
      assert.equal(durable?.mission.status, "failed");
      assert.equal(durable?.events.at(-1)?.type, "MissionFailed");
    } finally {
      store.close();
    }
  });

  it("永続化された状態を再オープンし、エージェントの呼び出しや新しいイベントなしで確認する", async () => {
    const directory = mkdtempSync(join(tmpdir(), "c2-runtime-reopen-"));
    const database = join(directory, "runtime.sqlite");
    let missionId: string;
    let eventCount: number;
    const originalStore = new SqliteStore(database);
    try {
      const originalAgents = createMockAgents();
      const originalRuntime = new CommandControlRuntime(originalStore, originalAgents);
      const completed = await originalRuntime.run({ goal: "Persist and reopen Mission" });
      missionId = completed.mission.id;
      eventCount = completed.events.length;
    } finally {
      originalStore.close();
    }

    const reopenedStore = new SqliteStore(database);
    try {
      const freshAgents = createMockAgents({ scenario: "terminal-fail" });
      const reopenedRuntime = new CommandControlRuntime(reopenedStore, freshAgents);
      const observed = reopenedRuntime.observeMission(missionId);

      assert.equal(observed?.status, "completed");
      assert.equal(observed?.tasks.length, 3);
      assert.equal(observed?.reports.length, 3);
      assert.equal(observed?.events.length, eventCount);
      assert.equal(observed?.events.at(-1)?.type, "MissionCompleted");
      assert.equal(freshAgents.commander.callCount, 0);
      assert.equal(freshAgents.lead.planCallCount, 0);
      assert.equal(freshAgents.lead.replanCallCount, 0);
      assert.equal(freshAgents.worker.callCount, 0);
      assert.equal(freshAgents.evaluator.callCount, 0);
      assert.equal(freshAgents.trace.entries.length, 0);
      assert.equal(reopenedStore.listEvents(missionId).length, eventCount);
    } finally {
      reopenedStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("同じインターフェースを通じてすべてのモック役割をLLMアダプターに置き換える", async () => {
    class FakeStructuredProvider implements StructuredLlmProvider {
      public readonly requests: StructuredLlmRequest[] = [];

      public async generate(request: StructuredLlmRequest): Promise<unknown> {
        this.requests.push(structuredClone(request));
        switch (request.operation) {
          case "create-mission":
            return DEFAULT_MISSION_PROPOSAL;
          case "plan":
          case "replan":
            return DEFAULT_TASK_PLAN;
          case "execute-task":
            return {
              output: { implementation: "fake structured LLM provider" },
              report: {
                status: "success",
                summary: "The fake provider completed the task",
                problems: [],
                risks: [],
                decisionRequired: false,
              },
            };
          case "evaluate-task":
            return {
              result: "pass",
              reasons: ["The fake provider result satisfies the criteria"],
              recommendation: "complete",
            };
        }
      }
    }

    const provider = new FakeStructuredProvider();
    const agents: RuntimeAgents = {
      commander: new LlmCommanderAgent(provider),
      lead: new LlmLeadAgent(provider),
      worker: new LlmWorkerAgent(provider),
      evaluator: new LlmEvaluatorAgent(provider),
    };
    const store = new SqliteStore();
    try {
      const result = await new CommandControlRuntime(store, agents).run({
        goal: "Run through replaceable LLM role adapters",
      });

      assert.equal(result.status, "completed");
      assert.deepEqual(
        provider.requests.map(({ operation }) => operation),
        [
          "create-mission",
          "plan",
          "execute-task",
          "evaluate-task",
          "execute-task",
          "evaluate-task",
          "execute-task",
          "evaluate-task",
        ],
      );
      assert.ok(
        provider.requests.every(
          ({ outputSchema, schemaName, system }) =>
            typeof outputSchema === "object" &&
            outputSchema !== null &&
            schemaName.length > 0 &&
            system.length > 0,
        ),
      );
      assert.deepEqual(
        store.listAgents().map(({ implementation }) => implementation),
        ["llm", "llm", "llm", "llm"],
      );
    } finally {
      store.close();
    }
  });
});
