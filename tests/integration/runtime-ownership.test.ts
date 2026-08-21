import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZodError } from "zod";

import type { RuntimeAgents } from "../../src/agents/interfaces.js";
import {
  DEFAULT_MISSION_PROPOSAL,
  createMockAgents,
} from "../../src/agents/mock-agents.js";
import type {
  EvaluationProposal,
  MissionProposal,
  TaskPlan,
  TaskResult,
} from "../../src/domain/index.js";
import { CommandControlRuntime } from "../../src/runtime/runtime.js";
import { SqliteStore } from "../../src/storage/sqlite/index.js";

const ONE_TASK_PLAN: TaskPlan = [
  {
    key: "implement",
    objective: "Implement the requested behavior",
    purpose: "Satisfy the goal",
    successCriteria: ["The requested behavior is implemented"],
    constraints: ["Do not modify unrelated behavior"],
    authority: {
      allowed: [
        "execution.method.select",
        "execution.tool.select",
        "code.edit",
        "report.submit",
        "execution.retry",
      ],
      prohibited: ["change external systems"],
      requiresApproval: [],
    },
    dependencies: [],
  },
];

const SUCCESS_RESULT: TaskResult = {
  output: { outcome: "implemented" },
  report: {
    status: "success",
    summary: "Implemented and checked the requested behavior",
    problems: [],
    risks: [],
    decisionRequired: false,
  },
};

const PASS_EVALUATION: EvaluationProposal = {
  result: "pass",
  reasons: ["The task result satisfies its success criteria"],
  recommendation: "complete",
};

function assertNoCompletion(store: SqliteStore): void {
  assert.equal(
    store.listEvents().some(
      ({ type }) => type === "TaskCompleted" || type === "MissionCompleted",
    ),
    false,
  );
  assert.equal(
    store.listTasks().some(({ status }) => status === "completed"),
    false,
  );
  assert.equal(
    store.listMissions().some(({ status }) => status === "completed"),
    false,
  );
}

describe("ランタイムによる状態所有権", () => {
  it("すべてのエージェント入力の変更を隔離し、ランタイムの状態遷移だけで完了処理を行う", async () => {
    const store = new SqliteStore();
    const input = { goal: "Preserve this original goal" };

    const agents: RuntimeAgents = {
      commander: {
        id: "hostile-commander",
        async createMission(goal) {
          goal.description = "Commander-mutated goal";
          goal.createdAt.setUTCFullYear(1999);
          return structuredClone(DEFAULT_MISSION_PROPOSAL);
        },
      },
      lead: {
        id: "hostile-lead",
        async plan(mission) {
          mission.goal = "Lead-mutated goal";
          mission.status = "completed";
          mission.intent.constraints.push("Lead-mutated constraint");
          return structuredClone(ONE_TASK_PLAN);
        },
        async replan(mission) {
          mission.status = "completed";
          return structuredClone(ONE_TASK_PLAN);
        },
      },
      worker: {
        id: "hostile-worker",
        async execute(task, context) {
          task.objective = "Worker-mutated objective";
          task.status = "completed";
          context.mission.goal = "Worker-mutated goal";
          context.authority.allowed.push("unbounded authority");
          return structuredClone(SUCCESS_RESULT);
        },
      },
      evaluator: {
        id: "hostile-evaluator",
        async evaluate(task, result) {
          task.status = "completed";
          task.objective = "Evaluator-mutated objective";
          result.report.status = "failure";
          result.report.summary = "Evaluator-mutated report";
          return structuredClone(PASS_EVALUATION);
        },
      },
    };

    try {
      const result = await new CommandControlRuntime(store, agents).run(input);

      assert.equal(input.goal, "Preserve this original goal");
      assert.equal(result.status, "completed");
      assert.equal(result.mission.goal, "Preserve this original goal");
      assert.deepEqual(result.mission.intent.constraints, [
        "Runtime owns every state transition",
      ]);
      assert.equal(result.tasks[0]?.objective, "Implement the requested behavior");
      assert.equal(result.tasks[0]?.status, "completed");
      assert.equal(result.reports[0]?.status, "success");
      assert.equal(
        result.reports[0]?.summary,
        "Implemented and checked the requested behavior",
      );

      const eventTypes = result.events.map(({ type }) => type);
      const taskEvaluation = eventTypes.indexOf("TaskEvaluationStarted");
      const taskCompletion = eventTypes.indexOf("TaskCompleted");
      const missionEvaluation = eventTypes.indexOf("MissionEvaluationStarted");
      const missionCompletion = eventTypes.indexOf("MissionCompleted");
      assert.ok(taskEvaluation >= 0 && taskCompletion > taskEvaluation);
      assert.ok(missionEvaluation >= 0 && missionCompletion > missionEvaluation);
      assert.equal(
        result.events.find(({ type }) => type === "TaskCompleted")?.actor,
        "runtime",
      );
      assert.equal(
        result.events.find(({ type }) => type === "MissionCompleted")?.actor,
        "runtime",
      );
    } finally {
      store.close();
    }
  });

  it("ミッション作成前に司令役の制御フィールドを拒否する", async () => {
    const store = new SqliteStore();
    const proposal = {
      ...structuredClone(DEFAULT_MISSION_PROPOSAL),
      status: "completed",
      id: "00000000-0000-4000-8000-000000000001",
    } as unknown as MissionProposal;
    const agents = createMockAgents({
      commander: { onCreateMission: async () => proposal },
      lead: { plan: ONE_TASK_PLAN },
    });

    try {
      await assert.rejects(
        new CommandControlRuntime(store, agents).run({ goal: "Invalid Commander output" }),
        ZodError,
      );
      assert.deepEqual(store.listMissions(), []);
      assert.deepEqual(store.listTasks(), []);
      assert.deepEqual(
        store.listEvents().map(({ type }) => type),
        ["DecisionRequested", "AuthorizationAllowed"],
      );
      assert.deepEqual(
        store
          .listAuthorizationRecords()
          .map(({ decisionType, result }) => [decisionType, result]),
        [["goal.create", "allow"]],
      );
    } finally {
      store.close();
    }
  });

  it("タスクを作成または完了せずにリード役の制御フィールドを拒否する", async () => {
    const store = new SqliteStore();
    const invalidPlan = [
      {
        ...structuredClone(ONE_TASK_PLAN[0]),
        id: "00000000-0000-4000-8000-000000000002",
        status: "completed",
        attempts: 99,
      },
    ] as unknown as TaskPlan;
    const agents = createMockAgents({
      lead: { onPlan: async () => invalidPlan },
    });

    try {
      const result = await new CommandControlRuntime(store, agents).run({
        goal: "Invalid Lead output",
      });
      assert.equal(result.status, "failed");
      assert.equal(store.listMissions()[0]?.status, "failed");
      assert.deepEqual(store.listTasks(), []);
      assertNoCompletion(store);
      assert.ok(result.events.some(({ type }) => type === "StructuredOutputRejected"));
      assert.ok(result.events.some(({ type }) => type === "MissionFailed"));
    } finally {
      store.close();
    }
  });

  it("ワーカーの制御フィールドを拒否し、権威ある状態を未完了のまま保持する", async () => {
    const store = new SqliteStore();
    const invalidResult = {
      ...structuredClone(SUCCESS_RESULT),
      status: "completed",
      taskId: "00000000-0000-4000-8000-000000000003",
    } as unknown as TaskResult;
    const agents = createMockAgents({
      lead: { plan: ONE_TASK_PLAN },
      worker: {
        onExecute: async (task, context) => {
          task.status = "completed";
          task.objective = "Illegitimate Worker objective";
          context.mission.goal = "Illegitimate Worker goal";
          return invalidResult;
        },
      },
    });

    try {
      const result = await new CommandControlRuntime(store, agents).run({
        goal: "Invalid Worker output",
      });
      assert.equal(result.status, "failed");
      assert.equal(store.listMissions()[0]?.status, "failed");
      assert.equal(store.listTasks()[0]?.status, "failed");
      assert.equal(store.listTasks()[0]?.objective, "Implement the requested behavior");
      assert.deepEqual(store.listReports(), []);
      assertNoCompletion(store);
      assert.ok(result.events.some(({ type }) => type === "StructuredOutputRejected"));
      assert.ok(result.events.some(({ type }) => type === "TaskFailed"));
      assert.ok(result.events.some(({ type }) => type === "MissionFailed"));
    } finally {
      store.close();
    }
  });

  it("完了への状態遷移が行われる前に評価者の制御フィールドを拒否する", async () => {
    const store = new SqliteStore();
    const invalidEvaluation = {
      ...structuredClone(PASS_EVALUATION),
      taskStatus: "completed",
      missionStatus: "completed",
    } as unknown as EvaluationProposal;
    const agents = createMockAgents({
      lead: { plan: ONE_TASK_PLAN },
      evaluator: {
        onEvaluate: async (task, result) => {
          task.status = "completed";
          result.report.status = "failure";
          return invalidEvaluation;
        },
      },
    });

    try {
      const result = await new CommandControlRuntime(store, agents).run({
        goal: "Invalid Evaluator output",
      });
      assert.equal(result.status, "failed");
      assert.equal(store.listMissions()[0]?.status, "failed");
      assert.equal(store.listTasks()[0]?.status, "failed");
      assert.equal(store.listReports()[0]?.status, "success");
      assertNoCompletion(store);
      assert.ok(result.events.some(({ type }) => type === "StructuredOutputRejected"));
      assert.ok(result.events.some(({ type }) => type === "TaskFailed"));
      assert.ok(result.events.some(({ type }) => type === "MissionFailed"));
    } finally {
      store.close();
    }
  });

  it("ランタイム境界で未知の依存関係と循環したリード計画の依存関係を拒否する", async () => {
    const invalidPlans: TaskPlan[] = [
      [
        {
          ...structuredClone(ONE_TASK_PLAN[0] as NonNullable<typeof ONE_TASK_PLAN[0]>),
          dependencies: ["missing-task"],
        },
      ],
      [
        {
          ...structuredClone(ONE_TASK_PLAN[0] as NonNullable<typeof ONE_TASK_PLAN[0]>),
          key: "first",
          dependencies: ["second"],
        },
        {
          ...structuredClone(ONE_TASK_PLAN[0] as NonNullable<typeof ONE_TASK_PLAN[0]>),
          key: "second",
          dependencies: ["first"],
        },
      ],
    ];

    for (const [index, invalidPlan] of invalidPlans.entries()) {
      const store = new SqliteStore();
      const agents = createMockAgents({
        lead: { onPlan: async () => invalidPlan },
      });
      try {
        const result = await new CommandControlRuntime(store, agents).run({
          goal: `Invalid dependency plan ${index}`,
        });
        assert.equal(result.status, "failed");
        assert.equal(store.listMissions()[0]?.status, "failed");
        assert.deepEqual(store.listTasks(), []);
        assertNoCompletion(store);
        assert.ok(result.events.some(({ type }) => type === "StructuredOutputRejected"));
        assert.ok(result.events.some(({ type }) => type === "MissionFailed"));
      } finally {
        store.close();
      }
    }
  });
});
