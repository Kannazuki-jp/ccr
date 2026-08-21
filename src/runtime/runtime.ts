/**
 * @file Mission の計画、実行、評価、再計画を統制する C2 オーケストレーターを実装します。
 */

import { randomUUID } from "node:crypto";
import { ZodError } from "zod";

import type { RuntimeAgents } from "../agents/interfaces.js";
import {
  AgentRecordSchema,
  DecisionRequestSchema,
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
  type AuthorizationResult,
  type AuthorityContext,
  type Decision,
  type DecisionRequest,
  type DecisionRequestContext,
  type DecisionType,
  type DelegationRequest,
  type DelegationResult,
  type Event,
  type EscalationRequest,
  type EscalationResolutionRequest,
  type EscalationResolutionResult,
  type EscalationResult,
  type EvaluationProposal,
  type EffectiveAuthority,
  type JsonValue,
  type Constraint,
  type Mission,
  type MissionStatus,
  type MissionRunInput,
  type Report,
  type ReplanContext,
  type ResourceScope,
  type Permission,
  type RoleAuthority,
  type RevocationRequest,
  type RevocationResult,
  type Task,
  type TaskPlan,
  type TaskResult,
  type TaskStatus,
} from "../domain/index.js";
import type {
  MissionSnapshot,
  SqliteStore,
} from "../storage/sqlite/sqlite-store.js";
import { DoctrineEnforcer } from "./doctrine/enforcer.js";
import type { DoctrineEnforcerOptions } from "./doctrine/enforcer.js";
import {
  issueRuntimeTransitionPermit,
  issueTaskAssignmentPermit,
} from "./transition-permit.js";

export interface RuntimeOptions {
  readonly maxRetries?: number;
  readonly maxReplans?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly agentImplementations?: Partial<
    Record<AgentRole, AgentImplementation>
  >;
  /** Configure role maxima; enforcement itself is not replaceable. */
  readonly doctrine?: Pick<DoctrineEnforcerOptions, "roleAuthorities">;
}

/** The narrow Doctrine contract consumed by the C2 orchestration layer. */
export interface RuntimeDoctrineEnforcer {
  authorize(request: DecisionRequest): Promise<AuthorizationResult>;
  delegate(request: DelegationRequest): Promise<DelegationResult>;
  revoke(request: RevocationRequest): Promise<RevocationResult>;
  escalate(request: EscalationRequest): Promise<EscalationResult>;
  resolveEscalation(
    request: EscalationResolutionRequest,
  ): Promise<EscalationResolutionResult>;
  resolveEffectiveAuthority(
    actorId: string,
    context: AuthorityContext,
  ): Promise<EffectiveAuthority>;
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

export class RuntimeAuthorizationError extends Error {
  public constructor(
    public readonly authorization: Exclude<
      AuthorizationResult,
      { result: "allow" }
    >,
  ) {
    super(authorization.reason);
    this.name = "RuntimeAuthorizationError";
  }
}

interface RuntimeDecisionInput {
  readonly actorId: string;
  readonly role: DecisionRequest["role"];
  readonly missionId: string;
  readonly taskId?: string;
  readonly decisionType: DecisionType;
  readonly action?: string;
  readonly resource?: ResourceScope;
  readonly context?: DecisionRequestContext;
}

/**
 * C2 の状態を一元管理する正式なオーケストレーターです。
 * エージェントは判断を提案できますが、検証済みの状態遷移をストアへ要求できるのはこのクラスだけです。
 */
export class CommandControlRuntime {
  private readonly maxRetries: number;
  private readonly maxReplans: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly agentImplementations: Partial<
    Record<AgentRole, AgentImplementation>
  >;
  private readonly doctrineEnforcer: RuntimeDoctrineEnforcer;

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
    const configuredRoleAuthorities = options.doctrine?.roleAuthorities;
    this.doctrineEnforcer = new DoctrineEnforcer(store, {
      ...(configuredRoleAuthorities === undefined
        ? {}
        : {
            roleAuthorities: protectedRuntimeRoleAuthorities(
              configuredRoleAuthorities,
            ),
          }),
      now: this.now,
      createId: this.createId,
    });
  }

  /** Submit a decision without granting the caller direct access to state mutation. */
  public authorizeDecision(
    request: DecisionRequest,
  ): Promise<AuthorizationResult> {
    if (request.role === "runtime" || request.actorId === "runtime") {
      return Promise.resolve({
        result: "deny",
        reason: "Runtime state transitions are available only to the internal orchestration path",
        violation: {
          code: "COMMAND_BOUNDARY_VIOLATION",
          actorId: request.actorId,
          decisionType: request.decisionType,
          message: "Public callers cannot exercise Runtime state-transition authority",
          createdAt: this.now(),
        },
      });
    }
    return this.requireDoctrineEnforcer().authorize(request);
  }

  /** Submit an explicit authority delegation through the Runtime boundary. */
  public delegateAuthority(
    request: DelegationRequest,
  ): Promise<DelegationResult> {
    return this.requireDoctrineEnforcer().delegate(request);
  }

  /** Revoke a previously issued authority grant through the Runtime boundary. */
  public revokeAuthority(
    request: RevocationRequest,
  ): Promise<RevocationResult> {
    return this.requireDoctrineEnforcer().revoke(request);
  }

  /** Persist and route an explicit escalation without mutating command-owned state. */
  public escalateDecision(
    request: EscalationRequest,
  ): Promise<EscalationResult> {
    return this.requireDoctrineEnforcer().escalate(request);
  }

  /** Resolve an open escalation only through its recorded target owner. */
  public resolveEscalation(
    request: EscalationResolutionRequest,
  ): Promise<EscalationResolutionResult> {
    return this.requireDoctrineEnforcer().resolveEscalation(request);
  }

  /** Inspect the current intersection of role, grants, constraints, and risk limits. */
  public resolveEffectiveAuthority(
    actorId: string,
    context: AuthorityContext,
  ): Promise<EffectiveAuthority> {
    return this.requireDoctrineEnforcer().resolveEffectiveAuthority(
      actorId,
      context,
    );
  }

  public async run(input: MissionRunInput): Promise<MissionRunResult> {
    const parsedInput = MissionRunInputSchema.parse(input);
    const createdAt = this.now();
    const missionId = this.createId();
    const goal = GoalSchema.parse({
      id: this.createId(),
      description: parsedInput.goal,
      createdAt,
    });

    await this.requireAuthorized({
      actorId: "human",
      role: "human",
      missionId,
      decisionType: "goal.create",
      context: { goalId: goal.id },
    });

    this.registerAgents(createdAt);

    // Parse the proposal before authorization or persistence. Agent-provided
    // IDs, statuses, timestamps, or other control fields are rejected by the
    // strict schema, while its measured risk becomes authorization context.
    const missionProposal = MissionProposalSchema.parse(
      await this.agents.commander.createMission(structuredClone(goal)),
    );
    await this.requireAuthorized({
      actorId: this.agents.commander.id,
      role: "commander",
      missionId,
      decisionType: "mission.create",
      context: {
        goalId: goal.id,
        ...(missionProposal.intent.risk === undefined
          ? {}
          : { risk: missionProposal.intent.risk }),
      },
    });

    let mission = MissionSchema.parse({
      id: missionId,
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
    await this.delegateMissionAuthorityToLead(mission);

    mission = await this.transitionMission(
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
      await this.requireAuthorized({
        actorId: this.agents.lead.id,
        role: "lead",
        missionId: mission.id,
        decisionType: "plan.modify",
        context: this.leadDecisionContext(mission, { phase: "initial" }),
      });
      initialPlan = TaskPlanSchema.parse(
        await this.agents.lead.plan(structuredClone(leadInput.mission)),
      );
    } catch (error) {
      if (error instanceof RuntimeAuthorizationError) throw error;
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
    await this.persistPlan(mission, initialPlan);

    mission = await this.transitionMission(
      mission.id,
      "executing",
      this.makeEvent(mission.id, "MissionExecutionStarted", "runtime", {
        taskCount: initialPlan.length,
      }),
    );

    return this.executeMission(mission, 0);
  }

  /** エージェントの呼び出しやイベントの追加を行わず、永続化済みの状態を読み取ります。 */
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
          mission = await this.transitionMission(
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

        mission = await this.transitionMission(
          mission.id,
          "blocked",
          this.makeEvent(mission.id, "MissionBlocked", "runtime", {
            reason: "No pending task has all dependencies completed",
            unfinishedTaskIds: unfinished.map((task) => task.id),
          }),
        );
        return this.toRunResult(this.requireSnapshot(mission.id));
      }

      let task = await this.assignAndStartTask(mission, runnable);
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
        ...(task.risk === undefined ? {} : { risk: task.risk }),
        attempt: task.attempts,
      });

      // Agents receive detached values. Mutating them cannot mutate authoritative
      // store state, and their output is parsed again at this Runtime boundary.
      let result: TaskResult;
      try {
        const workerInput = WorkerExecutionInputSchema.parse({ task, context });
        const executionActions = task.authority.allowed.filter(
          (action) =>
            isCanonicalDoctrineTarget(action) &&
            action !== "report.submit" &&
            action !== "execution.retry",
        );
        if (executionActions.length === 0) {
          throw new Error(
            `Task ${task.id} has no canonical Worker execution permission`,
          );
        }
        for (const action of executionActions) {
          await this.requireAuthorized({
            actorId: this.agents.worker.id,
            role: "worker",
            missionId: mission.id,
            taskId: task.id,
            decisionType: workerDecisionType(action),
            action,
            resource: { type: "task", taskId: task.id },
            context: this.workerDecisionContext(task, {
              attempt: task.attempts,
            }),
          });
        }
        result = TaskResultSchema.parse(
          await this.agents.worker.execute(
            structuredClone(workerInput.task),
            structuredClone(workerInput.context),
          ),
        );
      } catch (error) {
        if (error instanceof RuntimeAuthorizationError) throw error;
        return this.failFromAgentBoundary(
          mission,
          "worker",
          "execute",
          error,
          task,
        );
      }
      await this.requireAuthorized({
        actorId: this.agents.worker.id,
        role: "worker",
        missionId: mission.id,
        taskId: task.id,
        decisionType: "report.submit",
        resource: { type: "task", taskId: task.id },
        context: this.workerDecisionContext(task, {
          attempt: task.attempts,
          status: result.report.status,
        }),
      });
      const report = this.persistReport(mission, task, result);

      if (requiresEscalation(result)) {
        const boundary = await this.requestBoundaryEscalation({
          actorId: this.agents.worker.id,
          role: "worker",
          missionId: mission.id,
          taskId: task.id,
          decisionType: "mission.scope.modify",
          reason: escalationReason(result),
        });
        task = await this.transitionTask(
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
        mission = await this.transitionMission(
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
              target: boundary.escalation.targetRole,
              escalationId: boundary.escalation.id,
            },
          ),
        );
        return this.toRunResult(this.requireSnapshot(mission.id));
      }

      task = await this.transitionTask(
        task.id,
        "evaluating",
        this.makeEvent(mission.id, "TaskEvaluationStarted", "runtime", {
          taskId: task.id,
          reportId: report.id,
        }),
      );
      mission = await this.transitionMission(
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
        await this.requireAuthorized({
          actorId: this.agents.evaluator.id,
          role: "evaluator",
          missionId: mission.id,
          taskId: task.id,
          decisionType: "evaluation.verify",
          context: { reportId: report.id, attempt: task.attempts },
        });
        evaluation = EvaluationProposalSchema.parse(
          await this.agents.evaluator.evaluate(
            structuredClone(evaluatorInput.task),
            structuredClone(evaluatorInput.result),
          ),
        );
      } catch (error) {
        if (error instanceof RuntimeAuthorizationError) throw error;
        return this.failFromAgentBoundary(
          mission,
          "evaluator",
          "evaluate",
          error,
          task,
        );
      }
      await this.requireAuthorized({
        actorId: this.agents.evaluator.id,
        role: "evaluator",
        missionId: mission.id,
        taskId: task.id,
        decisionType:
          evaluation.result === "pass" ? "evaluation.pass" : "evaluation.fail",
        context: {
          reportId: report.id,
          recommendation: evaluation.recommendation,
        },
      });
      if (evaluation.result === "fail") {
        await this.requireAuthorized({
          actorId: this.agents.evaluator.id,
          role: "evaluator",
          missionId: mission.id,
          taskId: task.id,
          decisionType: "evaluation.recommend",
          context: { recommendation: evaluation.recommendation },
        });
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
        task = await this.transitionTask(
          task.id,
          "completed",
          this.makeEvent(mission.id, "TaskCompleted", "runtime", {
            taskId: task.id,
            reportId: report.id,
          }),
          { reportId: report.id, evaluation: "pass" },
        );
        const hasPending = this.requireSnapshot(mission.id).tasks.some(
          (candidate) => candidate.status === "pending",
        );
        if (hasPending) {
          mission = await this.transitionMission(
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
            return await this.failMissionAfterLimit(
              mission,
              task,
              `Retry limit exhausted after ${task.attempts} attempt(s)`,
            );
          }
          await this.requireAuthorized({
            actorId: this.agents.worker.id,
            role: "worker",
            missionId: mission.id,
            taskId: task.id,
            decisionType: "execution.retry",
            resource: { type: "task", taskId: task.id },
            context: this.workerDecisionContext(task, {
              nextAttempt: task.attempts + 1,
            }),
          });
          task = await this.transitionTask(
            task.id,
            "pending",
            this.makeEvent(mission.id, "TaskRetryScheduled", "runtime", {
              taskId: task.id,
              decisionId: decision.id,
              nextAttempt: task.attempts + 1,
            }),
          );
          mission = await this.transitionMission(
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
            return await this.failMissionAfterLimit(
              mission,
              task,
              `Replan limit exhausted after ${replanCount} replan(s)`,
            );
          }
          task = await this.transitionTask(
            task.id,
            "failed",
            this.makeEvent(mission.id, "TaskFailed", "runtime", {
              taskId: task.id,
              reportId: report.id,
              decisionId: decision.id,
              supersededByReplan: true,
            }),
          );
          mission = await this.transitionMission(
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
            await this.requireAuthorized({
              actorId: this.agents.lead.id,
              role: "lead",
              missionId: mission.id,
              taskId: task.id,
              decisionType: "plan.modify",
              context: this.leadDecisionContext(mission, {
                phase: "replan",
                replanCount: replanCount + 1,
              }),
            });
            replacementPlan = TaskPlanSchema.parse(
              await this.agents.lead.replan(
                structuredClone(leadInput.mission),
                structuredClone(leadInput.context),
              ),
            );
          } catch (error) {
            if (error instanceof RuntimeAuthorizationError) throw error;
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
            await this.requireAuthorized({
              actorId: this.agents.lead.id,
              role: "lead",
              missionId: mission.id,
              taskId: superseded.id,
              decisionType: "task.remove",
              context: this.leadDecisionContext(mission, {
                reason: "superseded-by-replan",
                failedTaskId: task.id,
              }),
            });
            await this.transitionTask(
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
          await this.persistPlan(mission, replacementPlan);
          mission = await this.transitionMission(
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
          const escalation = await this.doctrineEnforcer.escalate({
            id: this.createId(),
            missionId: mission.id,
            taskId: task.id,
            requesterId: this.agents.evaluator.id,
            decisionType: "mission.scope.modify",
            reason: evaluation.reasons.join("; "),
            targetRole: "commander",
            createdAt: this.now(),
          });
          if (escalation.result !== "escalate") {
            throw new RuntimeAuthorizationError(escalation);
          }
          task = await this.transitionTask(
            task.id,
            "blocked",
            this.makeEvent(mission.id, "TaskBlocked", "runtime", {
              taskId: task.id,
              decisionId: decision.id,
              reasons: evaluation.reasons,
            }),
          );
          mission = await this.transitionMission(
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
                target: escalation.escalation.targetRole,
                escalationId: escalation.escalation.id,
              },
            ),
          );
          return this.toRunResult(this.requireSnapshot(mission.id));
        }
        case "fail":
          task = await this.transitionTask(
            task.id,
            "failed",
            this.makeEvent(mission.id, "TaskFailed", "runtime", {
              taskId: task.id,
              decisionId: decision.id,
              reasons: evaluation.reasons,
            }),
          );
          await this.cancelPendingTasks(
            mission.id,
            "Mission failed after an unrecoverable evaluation",
            task.id,
          );
          mission = await this.transitionMission(
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

  private async persistPlan(mission: Mission, plan: TaskPlan): Promise<Task[]> {
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
        ...((proposal.risk ?? mission.intent.risk) === undefined
          ? {}
          : { risk: proposal.risk ?? mission.intent.risk }),
        authority: proposal.authority,
        dependencies: proposal.dependencies.map((key) => idsByKey.get(key)),
        status: "pending",
        attempts: 0,
        createdAt,
        updatedAt: createdAt,
      }),
    );
    for (const task of tasks) {
      await this.requireAuthorized({
        actorId: this.agents.lead.id,
        role: "lead",
        missionId: mission.id,
        taskId: task.id,
        decisionType: "task.create",
        context: {
          objective: task.objective,
          ...(task.risk === undefined ? {} : { risk: task.risk }),
        },
      });
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

  private async assignAndStartTask(
    mission: Mission,
    pending: Task,
  ): Promise<Task> {
    let task = pending;
    if (task.assignedAgentId === undefined) {
      const { request, authorization } = await this.requireAuthorizedRequest({
        actorId: this.agents.lead.id,
        role: "lead",
        missionId: mission.id,
        taskId: task.id,
        decisionType: "task.assign",
        context: this.leadDecisionContext(mission, {
          workerAgentId: this.agents.worker.id,
        }),
      });
      const assignmentEvent = EventSchema.parse({
        ...this.makeEvent(mission.id, "TaskAssigned", "runtime", {
          taskId: task.id,
          workerAgentId: this.agents.worker.id,
        }),
        createdAt: this.now(),
      });
      task = this.store.assignTaskAndEvent(
        task.id,
        this.agents.worker.id,
        assignmentEvent,
        issueTaskAssignmentPermit(request, authorization, assignmentEvent),
      );
    } else if (task.assignedAgentId !== this.agents.worker.id) {
      throw new Error(
        `Task ${task.id} is already assigned to ${task.assignedAgentId}`,
      );
    }

    const existingGrant = this.store
      .listAuthorityGrants(mission.id, this.agents.worker.id)
      .some(({ taskId, status }) => taskId === task.id && status === "active");
    if (!existingGrant) {
      const delegation = await this.doctrineEnforcer.delegate({
        issuerId: this.agents.lead.id,
        subjectId: this.agents.worker.id,
        missionId: mission.id,
        taskId: task.id,
        permissions: this.taskPermissions(task),
        constraints: this.taskConstraints(mission, task),
        riskLimits: mission.intent.riskLimits ?? [],
      });
      if (delegation.result !== "allow") {
        throw new RuntimeAuthorizationError(delegation);
      }
    }
    task = await this.transitionTask(
      task.id,
      "running",
      this.makeEvent(mission.id, "TaskStarted", "runtime", {
        taskId: pending.id,
        workerAgentId: this.agents.worker.id,
        attempt: pending.attempts + 1,
      }),
      undefined,
      task.attempts + 1,
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

  private async failMissionAfterLimit(
    mission: Mission,
    task: Task,
    reason: string,
  ): Promise<MissionRunResult> {
    const limitDecision = this.persistDecision(
      mission.id,
      task.id,
      "fail",
      [reason],
      "runtime",
    );
    await this.transitionTask(
      task.id,
      "failed",
      this.makeEvent(mission.id, "TaskFailed", "runtime", {
        taskId: task.id,
        decisionId: limitDecision.id,
        reason,
      }),
    );
    await this.cancelPendingTasks(mission.id, reason, task.id);
    await this.transitionMission(
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

  private async failFromAgentBoundary(
    mission: Mission,
    role: AgentRole,
    operation: string,
    error: unknown,
    task?: Task,
  ): Promise<MissionRunResult> {
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
      await this.transitionTask(
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
    await this.cancelPendingTasks(
      mission.id,
      `${failureType} at ${role}.${operation}`,
      persistedTask?.id,
    );
    await this.transitionMission(
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

  private async cancelPendingTasks(
    missionId: string,
    reason: string,
    relatedTaskId?: string,
  ): Promise<void> {
    for (const pending of this.store
      .listTasks(missionId)
      .filter((candidate) => candidate.status === "pending")) {
      await this.transitionTask(
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

  private async requireAuthorized(
    input: RuntimeDecisionInput,
  ): Promise<AuthorizationResult & { result: "allow" }> {
    return (await this.requireAuthorizedRequest(input)).authorization;
  }

  private async requireAuthorizedRequest(
    input: RuntimeDecisionInput,
  ): Promise<{
    request: DecisionRequest;
    authorization: AuthorizationResult & { result: "allow" };
  }> {
    const request = DecisionRequestSchema.parse({
      id: this.createId(),
      actorId: input.actorId,
      role: input.role,
      missionId: input.missionId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      decisionType: input.decisionType,
      action: input.action ?? input.decisionType,
      ...(input.resource === undefined ? {} : { resource: input.resource }),
      ...(input.context === undefined ? {} : { context: input.context }),
      createdAt: this.now(),
    });
    const result = await this.doctrineEnforcer.authorize(request);
    if (result.result !== "allow") {
      throw new RuntimeAuthorizationError(result);
    }
    return { request, authorization: result };
  }

  private async requestBoundaryEscalation(
    input: RuntimeDecisionInput & { readonly reason: string },
  ): Promise<AuthorizationResult & { result: "escalate" }> {
    const request = DecisionRequestSchema.parse({
      id: this.createId(),
      actorId: input.actorId,
      role: input.role,
      missionId: input.missionId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      decisionType: input.decisionType,
      action: input.action ?? input.decisionType,
      ...(input.resource === undefined ? {} : { resource: input.resource }),
      context: {
        ...(input.context ?? {}),
        intent: "request_change",
        requestedChange: { reason: input.reason },
      },
      createdAt: this.now(),
    });
    const result = await this.doctrineEnforcer.authorize(request);
    if (result.result !== "escalate") {
      if (result.result === "deny") {
        throw new RuntimeAuthorizationError(result);
      }
      throw new Error(
        `Expected ${input.decisionType} to cross the ${input.role} boundary`,
      );
    }
    return result;
  }

  private async transitionMission(
    missionId: string,
    nextStatus: MissionStatus,
    event: Event,
  ): Promise<Mission> {
    const current = this.store.getMission(missionId);
    if (current === undefined) {
      throw new Error(`Mission not found before transition: ${missionId}`);
    }
    const request = DecisionRequestSchema.parse({
      id: this.createId(),
      actorId: "runtime",
      role: "runtime",
      missionId,
      decisionType: "state.transition",
      action: "state.transition",
      context: {
        entity: "mission",
        entityId: missionId,
        from: current.status,
        to: nextStatus,
        eventType: event.type,
      },
      createdAt: this.now(),
    });
    const authorization = await this.doctrineEnforcer.authorize(request);
    if (authorization.result !== "allow") {
      throw new RuntimeAuthorizationError(authorization);
    }
    const authorizedEvent = EventSchema.parse({
      ...event,
      createdAt: this.now(),
    });
    const permit = issueRuntimeTransitionPermit(
      request,
      authorization,
      authorizedEvent,
    );
    return this.store.transitionMission(
      missionId,
      nextStatus,
      authorizedEvent,
      permit,
    );
  }

  private async transitionTask(
    taskId: string,
    nextStatus: TaskStatus,
    event: Event,
    evidence?: { readonly reportId: string; readonly evaluation: "pass" },
    attempts?: number,
  ): Promise<Task> {
    const current = this.store.getTask(taskId);
    if (current === undefined) {
      throw new Error(`Task not found before transition: ${taskId}`);
    }
    if (nextStatus === "completed" && evidence === undefined) {
      throw new Error(
        `Task ${taskId} completion requires persisted evidence and an Evaluator PASS`,
      );
    }
    const request = DecisionRequestSchema.parse({
      id: this.createId(),
      actorId: "runtime",
      role: "runtime",
      missionId: current.missionId,
      taskId,
      decisionType: "state.transition",
      action: "state.transition",
      context: {
        entity: "task",
        entityId: taskId,
        from: current.status,
        to: nextStatus,
        eventType: event.type,
        ...(evidence === undefined
          ? {}
          : {
              evaluationResult: evidence.evaluation,
              reportId: evidence.reportId,
            }),
        ...(attempts === undefined ? {} : { attempts }),
      },
      createdAt: this.now(),
    });
    const authorization = await this.doctrineEnforcer.authorize(request);
    if (authorization.result !== "allow") {
      throw new RuntimeAuthorizationError(authorization);
    }
    const authorizedEvent = EventSchema.parse({
      ...event,
      createdAt: this.now(),
    });
    const permit = issueRuntimeTransitionPermit(
      request,
      authorization,
      authorizedEvent,
    );
    return this.store.transitionTask(taskId, nextStatus, authorizedEvent, permit);
  }

  private requireSnapshot(missionId: string): MissionSnapshot {
    const snapshot = this.store.loadMissionSnapshot(missionId);
    if (snapshot === undefined) {
      throw new Error(`Mission not found after persistence: ${missionId}`);
    }
    return snapshot;
  }

  private taskPermissions(task: Task): Permission[] {
    const scope = { type: "task" as const, taskId: task.id };
    const actions = new Set(
      task.authority.allowed.filter(isCanonicalDoctrineTarget),
    );
    for (const approvalAction of task.authority.requiresApproval) {
      if (isCanonicalDoctrineTarget(approvalAction)) actions.add(approvalAction);
    }
    return [...actions].map((action) => ({ action, resource: scope }));
  }

  private async delegateMissionAuthorityToLead(mission: Mission): Promise<void> {
    const actions = [
      "task.*",
      "plan.modify",
      "authority.delegate",
      "execution.*",
      "report.submit",
      "code.*",
      "public_api.modify",
      "test.run",
      "tool.select",
    ];
    const result = await this.doctrineEnforcer.delegate({
      issuerId: this.agents.commander.id,
      subjectId: this.agents.lead.id,
      missionId: mission.id,
      permissions: actions.map((action) => ({
        action,
        resource: { type: "global" as const },
      })),
      constraints: [],
      riskLimits: [],
    });
    if (result.result !== "allow") throw new RuntimeAuthorizationError(result);
    const constraints = this.missionConstraints(mission);
    const riskLimits = mission.intent.riskLimits ?? [];
    if (constraints.length > 0 || riskLimits.length > 0) {
      const narrowing = await this.doctrineEnforcer.delegate({
        issuerId: this.agents.commander.id,
        subjectId: this.agents.lead.id,
        missionId: mission.id,
        permissions: [],
        constraints,
        riskLimits,
      });
      if (narrowing.result !== "allow") {
        throw new RuntimeAuthorizationError(narrowing);
      }
    }
  }

  private missionConstraints(mission: Mission): Constraint[] {
    const constraints: Constraint[] = [];
    mission.intent.constraints.forEach((raw, index) => {
      const parsed = parseConstraint(raw, undefined);
      if (parsed === undefined) return;
      constraints.push({
        id: `${this.agents.commander.id}:${mission.id}:constraint:${index}`,
        sourceId: this.agents.commander.id,
        ...parsed,
        inherited: true,
      });
    });
    return constraints;
  }

  private taskConstraints(mission: Mission, task: Task): Constraint[] {
    const scope = { type: "task" as const, taskId: task.id };
    const constraints: Constraint[] = [];
    const add = (
      sourceId: string,
      raw: string,
      fallbackKind: Constraint["kind"] | undefined,
      inherited: boolean,
      index: number,
    ): void => {
      const parsed = parseConstraint(raw, fallbackKind);
      if (parsed === undefined) return;
      constraints.push({
        id: `${sourceId}:${task.id}:constraint:${index}:${constraints.length}`,
        sourceId,
        ...parsed,
        scope,
        inherited,
      });
    };

    task.constraints.forEach((value, index) =>
      add(this.agents.lead.id, value, undefined, true, index));
    task.authority.prohibited.forEach((value, index) =>
      add(this.agents.lead.id, value, "prohibit", true, index));
    task.authority.requiresApproval.forEach((value, index) => {
      if (!isCanonicalDoctrineTarget(value)) return;
      constraints.push({
        id: `${this.agents.lead.id}:${task.id}:approval:${index}`,
        sourceId: this.agents.lead.id,
        kind: "require",
        target: "runtime.approval",
        scope,
        value,
        inherited: true,
      });
    });
    return constraints;
  }

  private workerDecisionContext(
    task: Task,
    context: DecisionRequestContext,
  ): DecisionRequestContext {
    return task.risk === undefined
      ? context
      : { ...context, risk: task.risk };
  }

  private leadDecisionContext(
    mission: Mission,
    context: DecisionRequestContext,
  ): DecisionRequestContext {
    return mission.intent.risk === undefined
      ? context
      : { ...context, risk: mission.intent.risk };
  }

  private requireDoctrineEnforcer(): RuntimeDoctrineEnforcer {
    return this.doctrineEnforcer;
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

function isCanonicalDoctrineTarget(value: string): boolean {
  return /^(?:\*|[a-z][a-z0-9_-]*(?:\.(?:\*|[a-z][a-z0-9_-]*))*)$/.test(
    value,
  );
}

function parseConstraint(
  raw: string,
  fallbackKind: Constraint["kind"] | undefined,
): Pick<Constraint, "kind" | "target" | "value"> | undefined {
  const explicit = /^(prohibit|require):(.+)$/.exec(raw);
  if (explicit !== null) {
    const target = explicit[2]!.trim();
    if (!isCanonicalDoctrineTarget(target)) return undefined;
    return {
      kind: explicit[1] as "prohibit" | "require",
      target,
    };
  }
  const limit = /^limit:([^<]+)<=(-?(?:\d+(?:\.\d+)?|\.\d+))$/.exec(raw);
  if (limit !== null) {
    const target = limit[1]!.trim();
    if (!isCanonicalDoctrineTarget(target)) return undefined;
    return { kind: "limit", target, value: Number(limit[2]) };
  }
  return fallbackKind !== undefined && isCanonicalDoctrineTarget(raw)
    ? { kind: fallbackKind, target: raw }
    : undefined;
}

function workerDecisionType(action: string): DecisionType {
  if (action === "execution.method.select") return action;
  if (action === "execution.tool.select" || action === "tool.select") {
    return "execution.tool.select";
  }
  if (action === "execution.retry") return action;
  if (action === "execution.procedure.modify" || action === "test.run") {
    return "execution.procedure.modify";
  }
  return "execution.local_change";
}

function protectedRuntimeRoleAuthorities(
  configured: readonly RoleAuthority[],
): readonly RoleAuthority[] {
  return [
    ...configured.filter(
      ({ subjectId, role }) =>
        subjectId !== "human" &&
        subjectId !== "runtime" &&
        role !== "human" &&
        role !== "runtime",
    ),
    {
      subjectId: "human",
      role: "human",
      permissions: [{ action: "*", resource: { type: "global" } }],
      constraints: [],
      riskLimits: [],
    },
    {
      subjectId: "runtime",
      role: "runtime",
      permissions: [
        { action: "state.transition", resource: { type: "global" } },
        { action: "authority.revoke", resource: { type: "global" } },
      ],
      constraints: [],
      riskLimits: [],
    },
  ];
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
