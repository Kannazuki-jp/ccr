import type {
  EvaluationProposal,
  Goal,
  Mission,
  MissionProposal,
  ReplanContext,
  Task,
  TaskPlan,
  TaskResult,
  WorkerContext,
} from "../domain/index.js";
import type {
  CommanderAgent,
  EvaluatorAgent,
  LeadAgent,
  RuntimeAgents,
  WorkerAgent,
} from "./interfaces.js";

type MaybePromise<T> = T | Promise<T>;

function snapshot<T>(value: T): T {
  return structuredClone(value);
}

function responseAt<T>(
  responses: readonly T[] | undefined,
  callIndex: number,
  fallback: () => T,
): T {
  if (responses === undefined || responses.length === 0) return fallback();
  return snapshot(responses[Math.min(callIndex, responses.length - 1)] as T);
}

export type MockScenario =
  | "happy"
  | "retry"
  | "replan"
  | "escalation"
  | "terminal-fail";

export type MockAgentRole = "commander" | "lead" | "worker" | "evaluator";
export type MockAgentOperation =
  | "createMission"
  | "plan"
  | "replan"
  | "execute"
  | "evaluate";

export interface MockCallTraceEntry {
  readonly sequence: number;
  readonly role: MockAgentRole;
  readonly operation: MockAgentOperation;
  readonly agentId: string;
  readonly callIndex: number;
  readonly entityId: string;
}

/** Shared deterministic trace for proving cross-role routing in integration tests. */
export class MockCallTrace {
  readonly #entries: MockCallTraceEntry[] = [];

  public get entries(): readonly MockCallTraceEntry[] {
    return this.#entries;
  }

  public record(entry: Omit<MockCallTraceEntry, "sequence">): void {
    this.#entries.push({ sequence: this.#entries.length, ...entry });
  }

  public reset(): void {
    this.#entries.length = 0;
  }
}

export const DEFAULT_MISSION_PROPOSAL: MissionProposal = {
  intent: {
    purpose: "Complete the supplied goal through a controlled C2 loop",
    endState: [
      "The requested outcome is delivered",
      "The outcome is checked against explicit success criteria",
    ],
    priorities: ["correctness", "traceability", "minimal scope"],
    constraints: ["Runtime owns every state transition"],
  },
  successCriteria: [
    "Every planned task passes evaluation",
    "The final mission state is persisted",
  ],
};

export const DEFAULT_TASK_PLAN: TaskPlan = [
  {
    key: "inspect",
    objective: "Inspect the current state relevant to the goal",
    purpose: "Establish the smallest reliable implementation context",
    successCriteria: ["Relevant current behavior and constraints are identified"],
    constraints: ["Do not change unrelated behavior"],
    authority: {
      allowed: ["read project files"],
      prohibited: ["change external systems"],
      requiresApproval: [],
    },
    dependencies: [],
  },
  {
    key: "implement",
    objective: "Implement the requested outcome",
    purpose: "Deliver the goal within the Commander's Intent",
    successCriteria: ["The requested behavior is implemented"],
    constraints: ["Preserve the stated constraints"],
    authority: {
      allowed: ["edit in-scope project files"],
      prohibited: ["change external systems"],
      requiresApproval: [],
    },
    dependencies: ["inspect"],
  },
  {
    key: "verify",
    objective: "Verify the implementation against the success criteria",
    purpose: "Provide objective evidence for completion",
    successCriteria: ["All applicable automated checks pass"],
    constraints: ["Do not hide failed checks"],
    authority: {
      allowed: ["run project checks"],
      prohibited: ["weaken success criteria"],
      requiresApproval: [],
    },
    dependencies: ["implement"],
  },
];

export const DEFAULT_REPLAN_TASK_PLAN: TaskPlan = [
  {
    key: "corrective-action",
    objective: "Correct the cause identified by the failed evaluation",
    purpose: "Recover the Mission without changing its intent",
    successCriteria: ["The failed criterion is satisfied by the corrective work"],
    constraints: ["Preserve the Commander's Intent and Mission constraints"],
    authority: {
      allowed: ["edit in-scope project files", "run project checks"],
      prohibited: ["change mission purpose", "weaken success criteria"],
      requiresApproval: [],
    },
    dependencies: [],
  },
];

function successfulResult(task: Task, context: WorkerContext): TaskResult {
  return {
    output: {
      taskId: task.id,
      objective: task.objective,
      attempt: context.attempt,
      outcome: "completed by deterministic mock",
    },
    report: {
      status: "success",
      summary: `Completed: ${task.objective}`,
      problems: [],
      risks: [],
      decisionRequired: false,
    },
  };
}

function escalationResult(task: Task): TaskResult {
  return {
    output: {
      taskId: task.id,
      outcome: "not executed because approval is required",
    },
    report: {
      status: "blocked",
      summary: `Blocked pending an authority decision: ${task.objective}`,
      problems: ["The requested action exceeds delegated authority"],
      risks: ["Continuing without approval would violate Mission constraints"],
      decisionRequired: true,
      escalation: {
        required: true,
        reason: "Commander or Human approval is required before continuing",
      },
    },
  };
}

const PASS_EVALUATION: EvaluationProposal = {
  result: "pass",
  reasons: ["The deterministic result satisfies the task success criteria"],
  recommendation: "complete",
};

const RETRY_EVALUATION: EvaluationProposal = {
  result: "fail",
  reasons: ["The first attempt needs one deterministic retry"],
  recommendation: "retry",
};

const REPLAN_EVALUATION: EvaluationProposal = {
  result: "fail",
  reasons: ["The original plan needs deterministic corrective work"],
  recommendation: "replan",
};

const ESCALATE_EVALUATION: EvaluationProposal = {
  result: "fail",
  reasons: ["The decision is outside delegated authority"],
  recommendation: "escalate",
};

const TERMINAL_FAIL_EVALUATION: EvaluationProposal = {
  result: "fail",
  reasons: ["The configured scenario is unrecoverable"],
  recommendation: "fail",
};

export interface CommanderCall {
  readonly goal: Goal;
}

export interface MockCommanderAgentOptions {
  readonly id?: string;
  readonly proposal?: MissionProposal;
  readonly onCreateMission?: (
    goal: Goal,
    callIndex: number,
  ) => MaybePromise<MissionProposal>;
  readonly trace?: MockCallTrace;
}

export class MockCommanderAgent implements CommanderAgent {
  public readonly id: string;
  public readonly calls: CommanderCall[] = [];
  readonly #proposal: MissionProposal;
  readonly #handler:
    | ((goal: Goal, callIndex: number) => MaybePromise<MissionProposal>)
    | undefined;
  readonly #trace: MockCallTrace | undefined;

  public constructor(options: MockCommanderAgentOptions = {}) {
    this.id = options.id ?? "mock-commander";
    this.#proposal = snapshot(options.proposal ?? DEFAULT_MISSION_PROPOSAL);
    this.#handler = options.onCreateMission;
    this.#trace = options.trace;
  }

  public get callCount(): number {
    return this.calls.length;
  }

  public async createMission(goal: Goal): Promise<MissionProposal> {
    const callIndex = this.calls.length;
    this.calls.push({ goal: snapshot(goal) });
    this.#trace?.record({
      role: "commander",
      operation: "createMission",
      agentId: this.id,
      callIndex,
      entityId: goal.id,
    });
    const response =
      this.#handler === undefined
        ? this.#proposal
        : await this.#handler(snapshot(goal), callIndex);
    return snapshot(response);
  }

  public resetHistory(): void {
    this.calls.length = 0;
  }
}

export interface LeadPlanCall {
  readonly mission: Mission;
}

export interface LeadReplanCall {
  readonly mission: Mission;
  readonly context: ReplanContext;
}

export interface MockLeadAgentOptions {
  readonly id?: string;
  readonly plan?: TaskPlan;
  readonly replan?: TaskPlan;
  readonly onPlan?: (
    mission: Mission,
    callIndex: number,
  ) => MaybePromise<TaskPlan>;
  readonly onReplan?: (
    mission: Mission,
    context: ReplanContext,
    callIndex: number,
  ) => MaybePromise<TaskPlan>;
  readonly trace?: MockCallTrace;
}

export class MockLeadAgent implements LeadAgent {
  public readonly id: string;
  public readonly planCalls: LeadPlanCall[] = [];
  public readonly replanCalls: LeadReplanCall[] = [];
  readonly #plan: TaskPlan;
  readonly #replan: TaskPlan;
  readonly #planHandler:
    | ((mission: Mission, callIndex: number) => MaybePromise<TaskPlan>)
    | undefined;
  readonly #replanHandler:
    | ((
        mission: Mission,
        context: ReplanContext,
        callIndex: number,
      ) => MaybePromise<TaskPlan>)
    | undefined;
  readonly #trace: MockCallTrace | undefined;

  public constructor(options: MockLeadAgentOptions = {}) {
    this.id = options.id ?? "mock-lead";
    this.#plan = snapshot(options.plan ?? DEFAULT_TASK_PLAN);
    this.#replan = snapshot(options.replan ?? DEFAULT_REPLAN_TASK_PLAN);
    this.#planHandler = options.onPlan;
    this.#replanHandler = options.onReplan;
    this.#trace = options.trace;
  }

  public get planCallCount(): number {
    return this.planCalls.length;
  }

  public get replanCallCount(): number {
    return this.replanCalls.length;
  }

  public async plan(mission: Mission): Promise<TaskPlan> {
    const callIndex = this.planCalls.length;
    this.planCalls.push({ mission: snapshot(mission) });
    this.#trace?.record({
      role: "lead",
      operation: "plan",
      agentId: this.id,
      callIndex,
      entityId: mission.id,
    });
    const response =
      this.#planHandler === undefined
        ? this.#plan
        : await this.#planHandler(snapshot(mission), callIndex);
    return snapshot(response);
  }

  public async replan(
    mission: Mission,
    context: ReplanContext,
  ): Promise<TaskPlan> {
    const callIndex = this.replanCalls.length;
    this.replanCalls.push({
      mission: snapshot(mission),
      context: snapshot(context),
    });
    this.#trace?.record({
      role: "lead",
      operation: "replan",
      agentId: this.id,
      callIndex,
      entityId: mission.id,
    });
    const response =
      this.#replanHandler === undefined
        ? this.#replan
        : await this.#replanHandler(
            snapshot(mission),
            snapshot(context),
            callIndex,
          );
    return snapshot(response);
  }

  public resetHistory(): void {
    this.planCalls.length = 0;
    this.replanCalls.length = 0;
  }
}

export interface WorkerCall {
  readonly task: Task;
  readonly context: WorkerContext;
}

export interface MockWorkerAgentOptions {
  readonly id?: string;
  readonly results?: readonly TaskResult[];
  readonly onExecute?: (
    task: Task,
    context: WorkerContext,
    callIndex: number,
  ) => MaybePromise<TaskResult>;
  readonly trace?: MockCallTrace;
}

export class MockWorkerAgent implements WorkerAgent {
  public readonly id: string;
  public readonly calls: WorkerCall[] = [];
  readonly #results: readonly TaskResult[] | undefined;
  readonly #handler:
    | ((
        task: Task,
        context: WorkerContext,
        callIndex: number,
      ) => MaybePromise<TaskResult>)
    | undefined;
  readonly #trace: MockCallTrace | undefined;

  public constructor(options: MockWorkerAgentOptions = {}) {
    this.id = options.id ?? "mock-worker";
    this.#results =
      options.results === undefined ? undefined : snapshot(options.results);
    this.#handler = options.onExecute;
    this.#trace = options.trace;
  }

  public get callCount(): number {
    return this.calls.length;
  }

  public async execute(task: Task, context: WorkerContext): Promise<TaskResult> {
    const callIndex = this.calls.length;
    this.calls.push({ task: snapshot(task), context: snapshot(context) });
    this.#trace?.record({
      role: "worker",
      operation: "execute",
      agentId: this.id,
      callIndex,
      entityId: task.id,
    });
    if (this.#handler !== undefined) {
      return snapshot(
        await this.#handler(snapshot(task), snapshot(context), callIndex),
      );
    }
    return responseAt(this.#results, callIndex, () =>
      successfulResult(task, context),
    );
  }

  public resetHistory(): void {
    this.calls.length = 0;
  }
}

export interface EvaluatorCall {
  readonly task: Task;
  readonly result: TaskResult;
}

export interface MockEvaluatorAgentOptions {
  readonly id?: string;
  readonly evaluations?: readonly EvaluationProposal[];
  readonly onEvaluate?: (
    task: Task,
    result: TaskResult,
    callIndex: number,
  ) => MaybePromise<EvaluationProposal>;
  readonly trace?: MockCallTrace;
}

export class MockEvaluatorAgent implements EvaluatorAgent {
  public readonly id: string;
  public readonly calls: EvaluatorCall[] = [];
  readonly #evaluations: readonly EvaluationProposal[] | undefined;
  readonly #handler:
    | ((
        task: Task,
        result: TaskResult,
        callIndex: number,
      ) => MaybePromise<EvaluationProposal>)
    | undefined;
  readonly #trace: MockCallTrace | undefined;

  public constructor(options: MockEvaluatorAgentOptions = {}) {
    this.id = options.id ?? "mock-evaluator";
    this.#evaluations =
      options.evaluations === undefined
        ? undefined
        : snapshot(options.evaluations);
    this.#handler = options.onEvaluate;
    this.#trace = options.trace;
  }

  public get callCount(): number {
    return this.calls.length;
  }

  public async evaluate(
    task: Task,
    result: TaskResult,
  ): Promise<EvaluationProposal> {
    const callIndex = this.calls.length;
    this.calls.push({ task: snapshot(task), result: snapshot(result) });
    this.#trace?.record({
      role: "evaluator",
      operation: "evaluate",
      agentId: this.id,
      callIndex,
      entityId: task.id,
    });
    if (this.#handler !== undefined) {
      return snapshot(
        await this.#handler(snapshot(task), snapshot(result), callIndex),
      );
    }
    return responseAt(this.#evaluations, callIndex, () => PASS_EVALUATION);
  }

  public resetHistory(): void {
    this.calls.length = 0;
  }
}

export interface MockAgentsOptions {
  readonly scenario?: MockScenario;
  readonly commander?: MockCommanderAgentOptions;
  readonly lead?: MockLeadAgentOptions;
  readonly worker?: MockWorkerAgentOptions;
  readonly evaluator?: MockEvaluatorAgentOptions;
}

export interface MockAgents extends RuntimeAgents {
  readonly commander: MockCommanderAgent;
  readonly lead: MockLeadAgent;
  readonly worker: MockWorkerAgent;
  readonly evaluator: MockEvaluatorAgent;
  readonly trace: MockCallTrace;
}

function scenarioWorkerHandler(
  scenario: MockScenario,
): NonNullable<MockWorkerAgentOptions["onExecute"]> {
  if (scenario === "escalation") {
    return (task) => escalationResult(task);
  }
  return (task, context) => successfulResult(task, context);
}

function scenarioEvaluatorHandler(
  scenario: MockScenario,
): NonNullable<MockEvaluatorAgentOptions["onEvaluate"]> {
  switch (scenario) {
    case "retry":
      return (_task, _result, callIndex) =>
        callIndex === 0 ? RETRY_EVALUATION : PASS_EVALUATION;
    case "replan":
      return (_task, _result, callIndex) =>
        callIndex === 0 ? REPLAN_EVALUATION : PASS_EVALUATION;
    case "escalation":
      return () => ESCALATE_EVALUATION;
    case "terminal-fail":
      return () => TERMINAL_FAIL_EVALUATION;
    case "happy":
      return () => PASS_EVALUATION;
  }
}

/**
 * Builds four interface-compatible deterministic agents.
 *
 * Scenario defaults are used only when a Worker/Evaluator response or handler is
 * not supplied explicitly. Custom handlers therefore remain the final authority
 * for a test fixture.
 */
export function createMockAgents(options: MockAgentsOptions = {}): MockAgents {
  const scenario = options.scenario ?? "happy";
  const trace = new MockCallTrace();

  const commander = new MockCommanderAgent({
    ...options.commander,
    trace,
  });
  const lead = new MockLeadAgent({
    ...options.lead,
    trace,
  });

  const workerOptions = options.worker ?? {};
  const worker = new MockWorkerAgent(
    workerOptions.onExecute !== undefined || workerOptions.results !== undefined
      ? { ...workerOptions, trace }
      : { ...workerOptions, onExecute: scenarioWorkerHandler(scenario), trace },
  );

  const evaluatorOptions = options.evaluator ?? {};
  const evaluator = new MockEvaluatorAgent(
    evaluatorOptions.onEvaluate !== undefined ||
      evaluatorOptions.evaluations !== undefined
      ? { ...evaluatorOptions, trace }
      : {
          ...evaluatorOptions,
          onEvaluate: scenarioEvaluatorHandler(scenario),
          trace,
        },
  );

  return { commander, lead, worker, evaluator, trace };
}

export {
  MockCommanderAgent as MockCommander,
  MockEvaluatorAgent as MockEvaluator,
  MockLeadAgent as MockLead,
  MockWorkerAgent as MockWorker,
};
