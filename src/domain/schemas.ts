/**
 * @file C2 の入力、提案、永続化エンティティを検証する Zod スキーマと型を定義します。
 */

import { z } from "zod";

const MAX_TEXT_LENGTH = 10_000;

export const IdentifierSchema = z.uuid();
export const TimestampSchema = z.coerce.date();
export const JsonValueSchema = z.json();

export const NonEmptyTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TEXT_LENGTH);

const UniqueTextListSchema = z
  .array(NonEmptyTextSchema)
  .superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          message: `duplicate value: ${value}`,
          path: [index],
        });
      }
      seen.add(value);
    }
  });

export const StringListSchema = UniqueTextListSchema;

export const GoalInputSchema = z
  .object({
    goal: NonEmptyTextSchema,
  })
  .strict();

export const GoalSchema = z
  .object({
    id: IdentifierSchema,
    description: NonEmptyTextSchema,
    createdAt: TimestampSchema,
  })
  .strict();

export const CommandersIntentSchema = z
  .object({
    purpose: NonEmptyTextSchema,
    endState: UniqueTextListSchema.min(1),
    priorities: UniqueTextListSchema.min(1),
    constraints: UniqueTextListSchema,
    /** Deterministic numeric ceilings carried by Commander's Intent. */
    riskLimits: z
      .array(
        z
          .object({
            dimension: NonEmptyTextSchema,
            operator: z.enum(["lt", "lte", "eq"]),
            value: z.number().finite(),
          })
          .strict(),
      )
      .optional(),
    /** Mission-level measurements supplied with decisions owned by the Lead. */
    risk: z.record(z.string(), z.number().finite()).optional(),
  })
  .strict();

export const AuthoritySchema = z
  .object({
    allowed: UniqueTextListSchema.default([]),
    prohibited: UniqueTextListSchema.default([]),
    requiresApproval: UniqueTextListSchema.default([]),
  })
  .strict()
  .superRefine((authority, context) => {
    const buckets = [
      ["allowed", authority.allowed],
      ["prohibited", authority.prohibited],
      ["requiresApproval", authority.requiresApproval],
    ] as const;
    const classifications = new Map<string, string>();

    for (const [bucket, entries] of buckets) {
      for (const [index, entry] of entries.entries()) {
        const existing = classifications.get(entry);
        if (existing !== undefined) {
          context.addIssue({
            code: "custom",
            message: `authority entry is already classified as ${existing}: ${entry}`,
            path: [bucket, index],
          });
        } else {
          classifications.set(entry, bucket);
        }
      }
    }
  });

export const MissionStatusSchema = z.enum([
  "created",
  "planning",
  "executing",
  "evaluating",
  "replanning",
  "blocked",
  "escalated",
  "completed",
  "failed",
  "cancelled",
]);

export const TaskStatusSchema = z.enum([
  "pending",
  "running",
  "evaluating",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);

export const MissionProposalSchema = z
  .object({
    intent: CommandersIntentSchema,
    successCriteria: UniqueTextListSchema.min(1),
  })
  .strict();

export const MissionSchema = z
  .object({
    id: IdentifierSchema,
    goal: NonEmptyTextSchema,
    intent: CommandersIntentSchema,
    successCriteria: UniqueTextListSchema.min(1),
    status: MissionStatusSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .refine((mission) => mission.updatedAt >= mission.createdAt, {
    message: "updatedAt must not precede createdAt",
    path: ["updatedAt"],
  });

const TaskKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "task key must contain only letters, numbers, period, underscore, or hyphen",
  );

export const TaskProposalSchema = z
  .object({
    key: TaskKeySchema,
    objective: NonEmptyTextSchema,
    purpose: NonEmptyTextSchema.optional(),
    successCriteria: UniqueTextListSchema.min(1),
    constraints: UniqueTextListSchema.default([]),
    /** Measurements used by deterministic Mission risk-limit checks. */
    risk: z.record(z.string(), z.number().finite()).optional(),
    authority: AuthoritySchema.default({
      allowed: [],
      prohibited: [],
      requiresApproval: [],
    }),
    dependencies: z.array(TaskKeySchema).default([]),
  })
  .strict()
  .superRefine((task, context) => {
    const seen = new Set<string>();
    for (const [index, dependency] of task.dependencies.entries()) {
      if (dependency === task.key) {
        context.addIssue({
          code: "custom",
          message: "task cannot depend on itself",
          path: ["dependencies", index],
        });
      }
      if (seen.has(dependency)) {
        context.addIssue({
          code: "custom",
          message: `duplicate dependency: ${dependency}`,
          path: ["dependencies", index],
        });
      }
      seen.add(dependency);
    }
  });

export const TaskPlanSchema = z
  .array(TaskProposalSchema)
  .min(1)
  .superRefine((tasks, context) => {
    const keyIndexes = new Map<string, number>();
    for (const [index, task] of tasks.entries()) {
      const existingIndex = keyIndexes.get(task.key);
      if (existingIndex !== undefined) {
        context.addIssue({
          code: "custom",
          message: `duplicate task key: ${task.key}`,
          path: [index, "key"],
        });
      } else {
        keyIndexes.set(task.key, index);
      }
    }

    for (const [taskIndex, task] of tasks.entries()) {
      for (const [dependencyIndex, dependency] of task.dependencies.entries()) {
        if (!keyIndexes.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: `unknown dependency: ${dependency}`,
            path: [taskIndex, "dependencies", dependencyIndex],
          });
        }
      }
    }

    const visitState = new Map<string, "visiting" | "visited">();
    const visit = (key: string, path: string[]): void => {
      const state = visitState.get(key);
      if (state === "visiting") {
        const taskIndex = keyIndexes.get(key);
        context.addIssue({
          code: "custom",
          message: `dependency cycle detected: ${[...path, key].join(" -> ")}`,
          path: taskIndex === undefined ? [] : [taskIndex, "dependencies"],
        });
        return;
      }
      if (state === "visited") return;

      visitState.set(key, "visiting");
      const taskIndex = keyIndexes.get(key);
      const task = taskIndex === undefined ? undefined : tasks[taskIndex];
      if (task !== undefined) {
        for (const dependency of task.dependencies) {
          if (keyIndexes.has(dependency)) visit(dependency, [...path, key]);
        }
      }
      visitState.set(key, "visited");
    };

    for (const task of tasks) visit(task.key, []);
  });

export const TaskSchema = z
  .object({
    id: IdentifierSchema,
    missionId: IdentifierSchema,
    objective: NonEmptyTextSchema,
    purpose: NonEmptyTextSchema.optional(),
    successCriteria: UniqueTextListSchema.min(1),
    constraints: UniqueTextListSchema,
    risk: z.record(z.string(), z.number().finite()).optional(),
    authority: AuthoritySchema,
    assignedAgentId: NonEmptyTextSchema.optional(),
    dependencies: z.array(IdentifierSchema),
    status: TaskStatusSchema,
    attempts: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((task, context) => {
    if (task.dependencies.includes(task.id)) {
      context.addIssue({
        code: "custom",
        message: "task cannot depend on itself",
        path: ["dependencies"],
      });
    }
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      context.addIssue({
        code: "custom",
        message: "task dependencies must be unique",
        path: ["dependencies"],
      });
    }
    if (task.updatedAt < task.createdAt) {
      context.addIssue({
        code: "custom",
        message: "updatedAt must not precede createdAt",
        path: ["updatedAt"],
      });
    }
  });

export const EscalationSchema = z
  .object({
    required: z.boolean(),
    reason: NonEmptyTextSchema.optional(),
  })
  .strict()
  .superRefine((escalation, context) => {
    if (escalation.required && escalation.reason === undefined) {
      context.addIssue({
        code: "custom",
        message: "an escalation reason is required when escalation is requested",
        path: ["reason"],
      });
    }
    if (!escalation.required && escalation.reason !== undefined) {
      context.addIssue({
        code: "custom",
        message: "an escalation reason must not be set when escalation is not required",
        path: ["reason"],
      });
    }
  });

export const ReportStatusSchema = z.enum(["success", "failure", "blocked"]);

export const StructuredReportSchema = z
  .object({
    status: ReportStatusSchema,
    summary: NonEmptyTextSchema,
    problems: UniqueTextListSchema.default([]),
    risks: UniqueTextListSchema.default([]),
    decisionRequired: z.boolean().default(false),
    escalation: EscalationSchema.optional(),
  })
  .strict();

export const TaskResultSchema = z
  .object({
    output: JsonValueSchema,
    report: StructuredReportSchema,
  })
  .strict();

export const ReportSchema = z
  .object({
    id: IdentifierSchema,
    missionId: IdentifierSchema,
    taskId: IdentifierSchema,
    agentId: NonEmptyTextSchema,
    attempt: z.number().int().positive(),
    output: JsonValueSchema,
    status: ReportStatusSchema,
    summary: NonEmptyTextSchema,
    problems: UniqueTextListSchema,
    risks: UniqueTextListSchema,
    decisionRequired: z.boolean(),
    escalation: EscalationSchema.optional(),
    createdAt: TimestampSchema,
  })
  .strict();

export const EvaluationResultSchema = z.enum(["pass", "fail"]);
export const EvaluationRecommendationSchema = z.enum([
  "complete",
  "retry",
  "replan",
  "escalate",
  "fail",
]);

export const EvaluationProposalSchema = z
  .object({
    result: EvaluationResultSchema,
    reasons: UniqueTextListSchema,
    recommendation: EvaluationRecommendationSchema,
  })
  .strict()
  .superRefine((evaluation, context) => {
    if (
      evaluation.result === "pass" &&
      evaluation.recommendation !== "complete"
    ) {
      context.addIssue({
        code: "custom",
        message: "a passing evaluation must recommend completion",
        path: ["recommendation"],
      });
    }
    if (
      evaluation.result === "fail" &&
      evaluation.recommendation === "complete"
    ) {
      context.addIssue({
        code: "custom",
        message: "a failing evaluation cannot recommend completion",
        path: ["recommendation"],
      });
    }
    if (evaluation.result === "fail" && evaluation.reasons.length === 0) {
      context.addIssue({
        code: "custom",
        message: "a failing evaluation must include at least one reason",
        path: ["reasons"],
      });
    }
  });

export const EvaluationSchema = z
  .object({
    id: IdentifierSchema,
    missionId: IdentifierSchema,
    taskId: IdentifierSchema,
    reportId: IdentifierSchema,
    attempt: z.number().int().positive(),
    result: EvaluationResultSchema,
    reasons: UniqueTextListSchema,
    recommendation: EvaluationRecommendationSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((evaluation, context) => {
    const proposalResult = EvaluationProposalSchema.safeParse({
      result: evaluation.result,
      reasons: evaluation.reasons,
      recommendation: evaluation.recommendation,
    });
    if (!proposalResult.success) {
      for (const issue of proposalResult.error.issues) {
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
      }
    }
  });

export const DecisionSchema = z
  .object({
    id: IdentifierSchema,
    missionId: IdentifierSchema,
    taskId: IdentifierSchema.optional(),
    actor: NonEmptyTextSchema,
    decision: NonEmptyTextSchema,
    rationale: UniqueTextListSchema,
    createdAt: TimestampSchema,
  })
  .strict();

export const EventSchema = z
  .object({
    id: IdentifierSchema,
    missionId: IdentifierSchema,
    type: NonEmptyTextSchema,
    actor: NonEmptyTextSchema.optional(),
    payload: JsonValueSchema,
    createdAt: TimestampSchema,
  })
  .strict();

export const AgentRoleSchema = z.enum([
  "commander",
  "lead",
  "worker",
  "evaluator",
]);

export const AgentImplementationSchema = z.enum(["mock", "llm", "custom"]);

export const AgentRecordSchema = z
  .object({
    id: NonEmptyTextSchema,
    name: NonEmptyTextSchema,
    role: AgentRoleSchema,
    implementation: AgentImplementationSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .refine((agent) => agent.updatedAt >= agent.createdAt, {
    message: "updatedAt must not precede createdAt",
    path: ["updatedAt"],
  });

export const WorkerContextSchema = z
  .object({
    mission: z
      .object({
        id: IdentifierSchema,
        goal: NonEmptyTextSchema,
        intent: CommandersIntentSchema,
        successCriteria: UniqueTextListSchema.min(1),
      })
      .strict(),
    relevantContext: JsonValueSchema,
    authority: AuthoritySchema,
    constraints: UniqueTextListSchema,
    risk: z.record(z.string(), z.number().finite()).optional(),
    attempt: z.number().int().positive(),
  })
  .strict();

export const ReplanContextSchema = z
  .object({
    failedTask: TaskSchema,
    result: TaskResultSchema,
    evaluation: EvaluationProposalSchema,
    tasks: z.array(TaskSchema),
    reports: z.array(ReportSchema),
  })
  .strict()
  .superRefine((replanContext, context) => {
    if (
      replanContext.evaluation.result !== "fail" ||
      replanContext.evaluation.recommendation !== "replan"
    ) {
      context.addIssue({
        code: "custom",
        message: "replan context requires a failing replan recommendation",
        path: ["evaluation"],
      });
    }
    if (
      !replanContext.tasks.some(
        (task) => task.id === replanContext.failedTask.id,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "replan task history must include the failed task",
        path: ["tasks"],
      });
    }
    for (const [index, task] of replanContext.tasks.entries()) {
      if (task.missionId !== replanContext.failedTask.missionId) {
        context.addIssue({
          code: "custom",
          message: "all replan tasks must belong to the failed task mission",
          path: ["tasks", index, "missionId"],
        });
      }
    }
    for (const [index, report] of replanContext.reports.entries()) {
      if (report.missionId !== replanContext.failedTask.missionId) {
        context.addIssue({
          code: "custom",
          message: "all replan reports must belong to the failed task mission",
          path: ["reports", index, "missionId"],
        });
      }
    }
  });

export const LeadPlanInputSchema = z
  .object({
    mission: MissionSchema,
  })
  .strict();

export const LeadReplanInputSchema = z
  .object({
    mission: MissionSchema,
    context: ReplanContextSchema,
  })
  .strict()
  .refine(
    ({ mission, context }) => mission.id === context.failedTask.missionId,
    {
      message: "replan context must belong to the supplied mission",
      path: ["context", "failedTask", "missionId"],
    },
  );

export const WorkerExecutionInputSchema = z
  .object({
    task: TaskSchema,
    context: WorkerContextSchema,
  })
  .strict()
  .refine(({ task, context }) => task.missionId === context.mission.id, {
    message: "worker context must belong to the task mission",
    path: ["context", "mission", "id"],
  });

export const EvaluatorInputSchema = z
  .object({
    task: TaskSchema,
    result: TaskResultSchema,
  })
  .strict();

export const MissionRunInputSchema = GoalInputSchema;

export type JsonValue = z.infer<typeof JsonValueSchema>;
export type GoalInput = z.infer<typeof GoalInputSchema>;
export type Goal = z.infer<typeof GoalSchema>;
export type CommandersIntent = z.infer<typeof CommandersIntentSchema>;
export type Authority = z.infer<typeof AuthoritySchema>;
export type MissionStatus = z.infer<typeof MissionStatusSchema>;
export type MissionProposal = z.infer<typeof MissionProposalSchema>;
export type Mission = z.infer<typeof MissionSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskProposal = z.infer<typeof TaskProposalSchema>;
export type TaskPlan = z.infer<typeof TaskPlanSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Escalation = z.infer<typeof EscalationSchema>;
export type ReportStatus = z.infer<typeof ReportStatusSchema>;
export type StructuredReport = z.infer<typeof StructuredReportSchema>;
export type TaskResult = z.infer<typeof TaskResultSchema>;
export type Report = z.infer<typeof ReportSchema>;
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
export type EvaluationRecommendation = z.infer<
  typeof EvaluationRecommendationSchema
>;
export type EvaluationProposal = z.infer<typeof EvaluationProposalSchema>;
export type Evaluation = z.infer<typeof EvaluationSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type Event = z.infer<typeof EventSchema>;
export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type AgentImplementation = z.infer<typeof AgentImplementationSchema>;
export type AgentRecord = z.infer<typeof AgentRecordSchema>;
export type WorkerContext = z.infer<typeof WorkerContextSchema>;
export type ReplanContext = z.infer<typeof ReplanContextSchema>;
export type LeadPlanInput = z.infer<typeof LeadPlanInputSchema>;
export type LeadReplanInput = z.infer<typeof LeadReplanInputSchema>;
export type WorkerExecutionInput = z.infer<typeof WorkerExecutionInputSchema>;
export type EvaluatorInput = z.infer<typeof EvaluatorInputSchema>;
export type MissionRunInput = z.infer<typeof MissionRunInputSchema>;
