import { randomUUID } from "node:crypto";
import { ZodError } from "zod";

import type { RuntimeAgents } from "../agents/interfaces.js";
import {
  AgentRecordSchema,
  DecisionSchema,
  EvaluationProposalSchema,
  EvaluatorInputSchema,
  EventSchema,
  GoalSchema,
  LeadPlanInputSchema,
  LeadReplanInputSchema,
  MissionProposalSchema,
  MissionRunInputSchema,
  MissionSchema,
  ReportSchema,
  TaskPlanSchema,
  TaskResultSchema,
  TaskSchema,
  WorkerExecutionInputSchema,
  WorkerContextSchema,
  type AgentImplementation,
  type AgentRecord,
  type AgentRole,
  type Decision,
  type Event,
  type EvaluationProposal,
  type JsonValue,
  type Mission,
  type MissionRunInput,
  type Report,
  type ReplanContext,
  type Task,
  type TaskPlan,
  type TaskResult,
} from "../domain/index.js";
import type {
  MissionSnapshot,
  SqliteStore,
} from "../storage/sqlite/sqlite-store.js";

export interface RuntimeOptions {
  readonly maxRetries?: number;
  readonly maxReplans?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly agentImplementations?: Partial<
    Record<AgentRole, AgentImplementation>
  >;
}

export interface MissionRunResult {
  readonly mission: Mission;
  readonly status: Mission["status"];
  readonly tasks: Task[];
  readonly reports: Report[];
  readonly decisions: Decision[];
  readonly events: Event[];
  readonly currentTask?: Task;
  readonly escalation?: {
    readonly required: true;
    readonly reason: string;
  };
  readonly finalResult?: string;
}

export class RuntimeLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RuntimeLimitError";
  }
}

/**
 * The authoritative C2 orchestrator. Agents can propose decisions, but only this
 * class asks the store to perform validated state transitions.
 */
export class CommandControlRuntime {
  private readonly maxRetries: number;
  private readonly maxReplans: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly agentImplementations: Partial<
    Record<AgentRole, AgentImplementation>
  >;

  public constructor(
    private readonly store: SqliteStore,
    private readonly agents: RuntimeAgents,
    options: RuntimeOptions = {},
  ) {
    this.maxRetries = requireNonNegativeInteger(
      options.maxRetries ?? 2,
      "maxRetries",
    );
    this.maxReplans = requireNonNegativeInteger(
      options.maxReplans ?? 2,
      "maxReplans",
    );
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.agentImplementations = options.agentImplementations ?? {};
  }

  public async run(input: MissionRunInput): Promise<MissionRunResult> {
    const parsedInput = MissionRunInputSchema.parse(input);
    const createdAt = this.now();
    const goal = GoalSchema.parse({
      id: this.createId(),
      description: parsedInput.goal,
      createdAt,
    });

    this.registerAgents(createdAt);

    // Parse the proposal before a Mission exists. Agent-provided IDs, statuses,
    // timestamps, or other control fields are rejected by the strict schema.
    const missionProposal = MissionProposalSchema.parse(
      await this.agents.commander.createMission(structuredClone(goal)),
    );

    let mission = MissionSchema.parse({
      id: this.createId(),
      goal: goal.description,
      intent: missionProposal.intent,
      successCriteria: missionProposal.successCriteria,
      status: "created",
      createdAt,
      updatedAt: createdAt,
    });
    this.store.saveMissionAndEvent(
      mission,
      this.makeEvent(mission.id, "MissionCreated", "runtime", {
        goalId: goal.id,
        goal: goal.description,
      }),
    );

    mission = this.store.transitionMission(
      mission.id,
      "planning",
      this.makeEvent(
        mission.id,
        "MissionPlanningStarted",
        this.agents.commander.id,
        { goalId: goal.id },
      ),
    );

    let initialPlan: TaskPlan;
    try {
      const leadInput = LeadPlanInputSchema.parse({ mission });
      initialPlan = TaskPlanSchema.parse(
        await this.agents.lead.plan(structuredClone(leadInput.mission)),
      );
    } catch (error) {
      return this.failFromAgentBoundary(
        mission,
        "lead",
        "plan",
        error,
      );
    }
    this.store.appendEvent(
      this.makeEvent(mission.id, "MissionPlanned", this.agents.lead.id, {
        taskCount: initialPlan.length,
      }),
    );
    this.persistPlan(mission, initialPlan);

    mission = this.store.transitionMission(
      mission.id,
      "executing",
      this.makeEvent(mission.id, "MissionExecutionStarted", "runtime", {
        taskCount: initialPlan.length,
      }),
    );

    return this.executeMission(mission, 0);
  }

  /** Read durable state without invoking an Agent or appending an Event. */
  public observeMission(missionId: string): MissionRunResult | undefined {
    const snapshot = this.store.loadMissionSnapshot(missionId);
    return snapshot === undefined ? undefined : this.toRunResult(snapshot);
  }

  private async executeMission(
    startingMission: Mission,
    startingReplans: number,
  ): Promise<MissionRunResult> {
    let mission = startingMission;
    let replanCount = startingReplans;

    for (;;) {
      const snapshot = this.requireSnapshot(mission.id);
      const runnable = firstRunnableTask(snapshot.tasks);

      if (runnable === undefined) {
        const unfinished = snapshot.tasks.filter(
          (task) =>
            task.status === "pending" ||
            task.status === "running" ||
            task.status === "evaluating" ||
            task.status === "blocked",
        );
        if (unfinished.length === 0 && snapshot.tasks.some(isCompletedTask)) {
          if (mission.status !== "evaluating") {
            throw new Error(
              `Mission ${mission.id} exhausted work from unexpected state ${mission.status}`,
            );
          }
          mission = this.store.transitionMission(
            mission.id,
            "completed",
            this.makeEvent(mission.id, "MissionCompleted", "runtime", {
              completedTaskIds: snapshot.tasks
                .filter(isCompletedTask)
                .map((task) => task.id),
            }),
          );
          return this.toRunResult(this.requireSnapshot(mission.id));
        }

        mission = this.store.transitionMission(
          mission.id,
          "blocked",
          this.makeEvent(mission.id, "MissionBlocked", "runtime", {
            reason: "No pending task has all dependencies completed",
            unfinishedTaskIds: unfinished.map((task) => task.id),
          }),
        );
        return this.toRunResult(this.requireSnapshot(mission.id));
      }

      let task = this.assignAndStartTask(mission, runnable);
      const context = WorkerContextSchema.parse({
        mission: {
          id: mission.id,
          goal: mission.goal,
          intent: mission.intent,
          successCriteria: mission.successCriteria,
        },
        relevantContext: dependencyContext(
          task,
          this.requireSnapshot(mission.id),
        ),
        authority: task.authority,
        constraints: task.constraints,
        attempt: task.attempts,
      });

      // Agents receive detached values. Mutating them cannot mutate authoritative
      // store state, and their output is parsed again at this Runtime boundary.
      let result: TaskResult;
      try {
        const workerInput = WorkerExecutionInputSchema.parse({ task, context });
        result = TaskResultSchema.parse(
          await this.agents.worker.execute(
            structuredClone(workerInput.task),
            structuredClone(workerInput.context),
          ),
        );
      } catch (error) {
        return this.failFromAgentBoundary(
          mission,
          "worker",
          "execute",
          error,
          task,
        );
      }
      const report = this.persistReport(mission, task, result);

      if (requiresEscalation(result)) {
        task = this.store.transitionTask(
          task.id,
          "blocked",
          this.makeEvent(mission.id, "TaskBlocked", this.agents.worker.id, {
            taskId: task.id,
            reportId: report.id,
            reason: escalationReason(result),
          }),
        );
        this.persistDecision(
          mission.id,
          task.id,
          "escalate",
          [escalationReason(result)],
          this.agents.worker.id,
        );
        mission = this.store.transitionMission(
          mission.id,
          "escalated",
          this.makeEvent(
            mission.id,
            "EscalationRequested",
            this.agents.worker.id,
            {
              taskId: task.id,
              reportId: report.id,
              reason: escalationReason(result),
              target: "commander-or-human",
            },
          ),
        );
        return this.toRunResult(this.requireSnapshot(mission.id));
      }

      task = this.store.transitionTask(
        task.id,
        "evaluating",
        this.makeEvent(mission.id, "TaskEvaluationStarted", "runtime", {
          taskId: task.id,
          reportId: report.id,
        }),
      );
      mission = this.store.transitionMission(
        mission.id,
        "evaluating",
        this.makeEvent(mission.id, "MissionEvaluationStarted", "runtime", {
          taskId: task.id,
          reportId: report.id,
        }),
      );

      let evaluation: EvaluationProposal;
      try {
        const evaluatorInput = EvaluatorInputSchema.parse({ task, result });
        evaluation = EvaluationProposalSchema.parse(
          await this.agents.evaluator.evaluate(
            structuredClone(evaluatorInput.task),
            structuredClone(evaluatorInput.result),
          ),
        );
      } catch (error) {
        return this.failFromAgentBoundary(
          mission,
          "evaluator",
          "evaluate",
          error,
          task,
        );
      }
      this.store.appendEvent(
        this.makeEvent(
          mission.id,
          evaluation.result === "pass"
            ? "EvaluationPassed"
            : "EvaluationFailed",
          this.agents.evaluator.id,
          {
            taskId: task.id,
            reportId: report.id,
            attempt: task.attempts,
            reasons: evaluation.reasons,
            recommendation: evaluation.recommendation,
          },
        ),
      );

      if (evaluation.result === "pass") {
        task = this.store.transitionTask(
          task.id,
          "completed",
          this.makeEvent(mission.id, "TaskCompleted", "runtime", {
            taskId: task.id,
            reportId: report.id,
          }),
        );
        const hasPending = this.requireSnapshot(mission.id).tasks.some(
          (candidate) => candidate.status === "pending",
        );
        if (hasPending) {
          mission = this.store.transitionMission(
            mission.id,
            "executing",
            this.makeEvent(
              mission.id,
              "MissionExecutionResumed",
              "runtime",
              { completedTaskId: task.id },
            ),
          );
          continue;
        }
        // Completion is evaluated at the top of the loop so the Runtime proves
        // no remaining runnable or unfinished work exists.
        continue;
      }

      const decision = this.persistDecision(
        mission.id,
        task.id,
        evaluation.recommendation,
        evaluation.reasons,
        this.agents.evaluator.id,
      );
      switch (evaluation.recommendation) {
        case "retry": {
          if (task.attempts > this.maxRetries) {
            return this.failMissionAfterLimit(
              mission,
              task,
              `Retry limit exhausted after ${task.attempts} attempt(s)`,
            );
          }
          task = this.store.transitionTask(
            task.id,
            "pending",
            this.makeEvent(mission.id, "TaskRetryScheduled", "runtime", {
              taskId: task.id,
              decisionId: decision.id,
              nextAttempt: task.attempts + 1,
            }),
          );
          mission = this.store.transitionMission(
            mission.id,
            "executing",
            this.makeEvent(mission.id, "MissionExecutionResumed", "runtime", {
              taskId: task.id,
              reason: "retry",
            }),
          );
          continue;
        }
        case "replan": {
          if (replanCount >= this.maxReplans) {
            return this.failMissionAfterLimit(
              mission,
              task,
              `Replan limit exhausted after ${replanCount} replan(s)`,
            );
          }
          task = this.store.transitionTask(
            task.id,
            "failed",
            this.makeEvent(mission.id, "TaskFailed", "runtime", {
              taskId: task.id,
              reportId: report.id,
              decisionId: decision.id,
              supersededByReplan: true,
            }),
          );
          mission = this.store.transitionMission(
            mission.id,
            "replanning",
            this.makeEvent(mission.id, "MissionReplanningStarted", "runtime", {
              taskId: task.id,
              decisionId: decision.id,
            }),
          );
          const replanContext: ReplanContext = {
            failedTask: task,
            result,
            evaluation,
            tasks: this.store.listTasks(mission.id),
            reports: this.store.listReports(mission.id),
          };
          let replacementPlan: TaskPlan;
          try {
            const leadInput = LeadReplanInputSchema.parse({
              mission,
              context: replanContext,
            });
            replacementPlan = TaskPlanSchema.parse(
              await this.agents.lead.replan(
                structuredClone(leadInput.mission),
                structuredClone(leadInput.context),
              ),
            );
          } catch (error) {
            return this.failFromAgentBoundary(
              mission,
              "lead",
              "replan",
              error,
              task,
            );
          }
          replanCount += 1;
          this.store.appendEvent(
            this.makeEvent(
              mission.id,
              "MissionReplanned",
              this.agents.lead.id,
              {
                failedTaskId: task.id,
                replacementTaskCount: replacementPlan.length,
                replanCount,
              },
            ),
          );
          // A replan replaces all not-yet-started work. Keeping old pending
          // tasks could strand dependencies on the failed task or execute a
          // plan that the Lead has explicitly superseded.
          for (const superseded of this.store
            .listTasks(mission.id)
            .filter((candidate) => candidate.status === "pending")) {
            this.store.transitionTask(
              superseded.id,
              "cancelled",
              this.makeEvent(
                mission.id,
                "TaskCancelledByReplan",
                "runtime",
                {
                  taskId: superseded.id,
                  failedTaskId: task.id,
                  replanCount,
                },
              ),
            );
          }
          this.persistPlan(mission, replacementPlan);
          mission = this.store.transitionMission(
            mission.id,
            "executing",
            this.makeEvent(mission.id, "MissionExecutionResumed", "runtime", {
              reason: "replan",
              replanCount,
            }),
          );
          continue;
        }
        case "escalate": {
          task = this.store.transitionTask(
            task.id,
            "blocked",
            this.makeEvent(mission.id, "TaskBlocked", "runtime", {
              taskId: task.id,
              decisionId: decision.id,
              reasons: evaluation.reasons,
            }),
          );
          mission = this.store.transitionMission(
            mission.id,
            "escalated",
            this.makeEvent(
              mission.id,
              "EscalationRequested",
              this.agents.evaluator.id,
              {
                taskId: task.id,
                decisionId: decision.id,
                reasons: evaluation.reasons,
                target: "commander-or-human",
              },
            ),
          );
          return this.toRunResult(this.requireSnapshot(mission.id));
        }
        case "fail":
          task = this.store.transitionTask(
            task.id,
            "failed",
            this.makeEvent(mission.id, "TaskFailed", "runtime", {
              taskId: task.id,
              decisionId: decision.id,
              reasons: evaluation.reasons,
            }),
          );
          this.cancelPendingTasks(
            mission.id,
            "Mission failed after an unrecoverable evaluation",
            task.id,
          );
          mission = this.store.transitionMission(
            mission.id,
            "failed",
            this.makeEvent(mission.id, "MissionFailed", "runtime", {
              taskId: task.id,
              decisionId: decision.id,
              reasons: evaluation.reasons,
            }),
          );
          return this.toRunResult(this.requireSnapshot(mission.id));
        case "complete":
          // EvaluationProposalSchema rejects fail/complete before this switch.
          throw new Error("Unreachable fail/complete evaluation");
      }
    }
  }

  private persistPlan(mission: Mission, plan: TaskPlan): Task[] {
    const idsByKey = new Map(
      plan.map((proposal) => [proposal.key, this.createId()] as const),
    );
    const createdAt = this.now();
    const tasks = plan.map((proposal) =>
      TaskSchema.parse({
        id: idsByKey.get(proposal.key),
        missionId: mission.id,
        objective: proposal.objective,
        ...(proposal.purpose === undefined
          ? {}
          : { purpose: proposal.purpose }),
        successCriteria: proposal.successCriteria,
        constraints: proposal.constraints,
        authority: proposal.authority,
        dependencies: proposal.dependencies.map((key) => idsByKey.get(key)),
        status: "pending",
        attempts: 0,
        createdAt,
        updatedAt: createdAt,
      }),
    );
    for (const task of tasks) {
      this.store.saveTaskAndEvent(
        task,
        this.makeEvent(mission.id, "TaskCreated", this.agents.lead.id, {
          taskId: task.id,
          objective: task.objective,
          dependencies: task.dependencies,
        }),
      );
    }
    return tasks;
  }

  private assignAndStartTask(mission: Mission, pending: Task): Task {
    const assignedAt = this.now();
    let task = TaskSchema.parse({
      ...pending,
      assignedAgentId: this.agents.worker.id,
      attempts: pending.attempts + 1,
      updatedAt: assignedAt,
    });
    this.store.saveTaskAndEvent(
      task,
      this.makeEvent(mission.id, "TaskAssigned", "runtime", {
        taskId: task.id,
        workerAgentId: this.agents.worker.id,
        attempt: task.attempts,
      }),
    );
    task = this.store.transitionTask(
      task.id,
      "running",
      this.makeEvent(mission.id, "TaskStarted", this.agents.worker.id, {
        taskId: task.id,
        attempt: task.attempts,
      }),
    );
    return task;
  }

  private persistReport(
    mission: Mission,
    task: Task,
    result: TaskResult,
  ): Report {
    const report = ReportSchema.parse({
      id: this.createId(),
      missionId: mission.id,
      taskId: task.id,
      agentId: this.agents.worker.id,
      attempt: task.attempts,
      output: result.output,
      status: result.report.status,
      summary: result.report.summary,
      problems: result.report.problems,
      risks: result.report.risks,
      decisionRequired: result.report.decisionRequired,
      ...(result.report.escalation === undefined
        ? {}
        : { escalation: result.report.escalation }),
      createdAt: this.now(),
    });
    this.store.saveReportAndEvent(
      report,
      this.makeEvent(mission.id, "ReportSubmitted", this.agents.worker.id, {
        taskId: task.id,
        reportId: report.id,
        status: report.status,
        attempt: report.attempt,
      }),
    );
    return report;
  }

  private persistDecision(
    missionId: string,
    taskId: string,
    decisionText: string,
    rationale: string[],
    actor: string,
  ): Decision {
    const decision = DecisionSchema.parse({
      id: this.createId(),
      missionId,
      taskId,
      actor,
      decision: decisionText,
      rationale,
      createdAt: this.now(),
    });
    this.store.saveDecisionAndEvent(
      decision,
      this.makeEvent(missionId, "DecisionMade", actor, {
        taskId,
        decisionId: decision.id,
        decision: decisionText,
        rationale,
      }),
    );
    return decision;
  }

  private failMissionAfterLimit(
    mission: Mission,
    task: Task,
    reason: string,
  ): MissionRunResult {
    const limitDecision = this.persistDecision(
      mission.id,
      task.id,
      "fail",
      [reason],
      "runtime",
    );
    this.store.transitionTask(
      task.id,
      "failed",
      this.makeEvent(mission.id, "TaskFailed", "runtime", {
        taskId: task.id,
        decisionId: limitDecision.id,
        reason,
      }),
    );
    this.cancelPendingTasks(mission.id, reason, task.id);
    this.store.transitionMission(
      mission.id,
      "failed",
      this.makeEvent(mission.id, "MissionFailed", "runtime", {
        taskId: task.id,
        decisionId: limitDecision.id,
        reason,
      }),
    );
    return this.toRunResult(this.requireSnapshot(mission.id));
  }

  private failFromAgentBoundary(
    mission: Mission,
    role: AgentRole,
    operation: string,
    error: unknown,
    task?: Task,
  ): MissionRunResult {
    const persistedMission = this.store.getMission(mission.id) ?? mission;
    const persistedTask =
      task === undefined ? undefined : this.store.getTask(task.id) ?? task;
    const failureType =
      error instanceof ZodError
        ? "StructuredOutputRejected"
        : "AgentInvocationFailed";
    const details = boundaryErrorDetails(error);
    this.store.appendEvent(
      this.makeEvent(mission.id, failureType, "runtime", {
        role,
        operation,
        ...(persistedTask === undefined ? {} : { taskId: persistedTask.id }),
        details,
      }),
    );

    if (
      persistedTask !== undefined &&
      (persistedTask.status === "running" ||
        persistedTask.status === "evaluating")
    ) {
      this.store.transitionTask(
        persistedTask.id,
        "failed",
        this.makeEvent(mission.id, "TaskFailed", "runtime", {
          taskId: persistedTask.id,
          reason: failureType,
          role,
          operation,
        }),
      );
    }
    this.cancelPendingTasks(
      mission.id,
      `${failureType} at ${role}.${operation}`,
      persistedTask?.id,
    );
    this.store.transitionMission(
      mission.id,
      "failed",
      this.makeEvent(mission.id, "MissionFailed", "runtime", {
        ...(persistedTask === undefined ? {} : { taskId: persistedTask.id }),
        reason: failureType,
        role,
        operation,
      }),
    );
    return this.toRunResult(this.requireSnapshot(persistedMission.id));
  }

  private cancelPendingTasks(
    missionId: string,
    reason: string,
    relatedTaskId?: string,
  ): void {
    for (const pending of this.store
      .listTasks(missionId)
      .filter((candidate) => candidate.status === "pending")) {
      this.store.transitionTask(
        pending.id,
        "cancelled",
        this.makeEvent(missionId, "TaskCancelled", "runtime", {
          taskId: pending.id,
          ...(relatedTaskId === undefined ? {} : { relatedTaskId }),
          reason,
        }),
      );
    }
  }

  private registerAgents(timestamp: Date): void {
    const registrations: [AgentRole, string][] = [
      ["commander", this.agents.commander.id],
      ["lead", this.agents.lead.id],
      ["worker", this.agents.worker.id],
      ["evaluator", this.agents.evaluator.id],
    ];
    for (const [role, id] of registrations) {
      const existing = this.store.getAgent(id);
      const record: AgentRecord = AgentRecordSchema.parse({
        id,
        name: id,
        role,
        implementation:
          this.agentImplementations[role] ?? inferImplementation(id),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      this.store.saveAgent(record);
    }
  }

  private makeEvent(
    missionId: string,
    type: string,
    actor: string,
    payload: JsonValue,
  ): Event {
    return EventSchema.parse({
      id: this.createId(),
      missionId,
      type,
      actor,
      payload,
      createdAt: this.now(),
    });
  }

  private requireSnapshot(missionId: string): MissionSnapshot {
    const snapshot = this.store.loadMissionSnapshot(missionId);
    if (snapshot === undefined) {
      throw new Error(`Mission not found after persistence: ${missionId}`);
    }
    return snapshot;
  }

  private toRunResult(snapshot: MissionSnapshot): MissionRunResult {
    const latestTaskId = [...snapshot.events]
      .reverse()
      .map(eventTaskId)
      .find((taskId) => taskId !== undefined);
    const latestReferencedTask =
      latestTaskId === undefined
        ? undefined
        : snapshot.tasks.find((task) => task.id === latestTaskId);
    const currentTask =
      snapshot.mission.status === "completed"
        ? undefined
        : latestReferencedTask ??
          snapshot.tasks.find((task) => task.status === "blocked") ??
          snapshot.tasks.find(
            (task) =>
              task.status === "running" || task.status === "evaluating",
          ) ??
          snapshot.tasks.find((task) => task.status === "pending");
    const escalationEvent = [...snapshot.events]
      .reverse()
      .find((event) => event.type === "EscalationRequested");
    const escalationReasonValue =
      escalationEvent !== undefined &&
      typeof escalationEvent.payload === "object" &&
      escalationEvent.payload !== null &&
      !Array.isArray(escalationEvent.payload)
        ? escalationEvent.payload.reason ?? escalationEvent.payload.reasons
        : undefined;
    const escalationReason = Array.isArray(escalationReasonValue)
      ? escalationReasonValue.join("; ")
      : typeof escalationReasonValue === "string"
        ? escalationReasonValue
        : "Escalation requested";
    const finalResult =
      snapshot.mission.status === "completed"
        ? "Mission completed after all active tasks passed evaluation"
        : snapshot.mission.status === "failed"
          ? "Mission failed"
          : undefined;
    return {
      mission: snapshot.mission,
      status: snapshot.mission.status,
      tasks: snapshot.tasks,
      reports: snapshot.reports,
      decisions: snapshot.decisions,
      events: snapshot.events,
      ...(currentTask === undefined ? {} : { currentTask }),
      ...(snapshot.mission.status === "escalated"
        ? {
            escalation: {
              required: true as const,
              reason: escalationReason,
            },
          }
        : {}),
      ...(finalResult === undefined ? {} : { finalResult }),
    };
  }
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function inferImplementation(id: string): AgentImplementation {
  const normalized = id.toLowerCase();
  if (normalized.includes("llm")) return "llm";
  if (normalized.includes("mock")) return "mock";
  return "custom";
}

function firstRunnableTask(tasks: Task[]): Task | undefined {
  const completed = new Set(
    tasks.filter(isCompletedTask).map((task) => task.id),
  );
  return tasks.find(
    (task) =>
      task.status === "pending" &&
      task.dependencies.every((dependency) => completed.has(dependency)),
  );
}

function isCompletedTask(task: Task): boolean {
  return task.status === "completed";
}

function dependencyContext(
  task: Task,
  snapshot: MissionSnapshot,
): JsonValue {
  return {
    completedDependencies: task.dependencies.map((dependencyId) => {
      const dependency = snapshot.tasks.find(
        (candidate) => candidate.id === dependencyId,
      );
      const reports = snapshot.reports.filter(
        (report) => report.taskId === dependencyId,
      );
      return {
        taskId: dependencyId,
        objective: dependency?.objective ?? "unknown dependency",
        latestSummary: reports.at(-1)?.summary ?? null,
      };
    }),
  };
}

function requiresEscalation(result: TaskResult): boolean {
  return (
    result.report.status === "blocked" ||
    result.report.decisionRequired ||
    result.report.escalation?.required === true
  );
}

function escalationReason(result: TaskResult): string {
  return (
    result.report.escalation?.reason ??
    result.report.problems[0] ??
    result.report.summary
  );
}

function eventTaskId(event: Event): string | undefined {
  if (
    typeof event.payload !== "object" ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    return undefined;
  }
  return typeof event.payload.taskId === "string"
    ? event.payload.taskId
    : undefined;
}

function boundaryErrorDetails(error: unknown): JsonValue {
  if (error instanceof ZodError) {
    return {
      kind: "schema-validation",
      issues: error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    };
  }
  if (error instanceof Error) {
    return { kind: error.name, message: error.message };
  }
  return { kind: "unknown", message: String(error) };
}
