import { z } from "zod";

import type {
  CommanderAgent,
  EvaluatorAgent,
  LeadAgent,
  WorkerAgent,
} from "../agents/interfaces.js";
import {
  EvaluationProposalSchema,
  EvaluatorInputSchema,
  JsonValueSchema,
  LeadPlanInputSchema,
  LeadReplanInputSchema,
  MissionProposalSchema,
  TaskPlanSchema,
  TaskResultSchema,
  WorkerExecutionInputSchema,
  type EvaluationProposal,
  type Goal,
  type Mission,
  type MissionProposal,
  type ReplanContext,
  type Task,
  type TaskPlan,
  type TaskResult,
  type WorkerContext,
} from "../domain/index.js";
import type {
  LlmOperation,
  StructuredLlmProvider,
  StructuredLlmRequest,
} from "./provider.js";

const SYSTEM_PROMPTS = {
  commander:
    "You are the Commander. Convert only the supplied goal into purpose, end state, priorities, constraints, and success criteria. Specify WHY, WHAT, and BOUNDARIES, but do not prescribe implementation HOW. Return only the requested structured output.",
  lead:
    "You are the Lead Planner. Decompose only the supplied mission and current state into a minimal sequentially executable task plan. Use task keys for dependency references, preserve intent and constraints, and do not invent doctrine. Return only the requested structured output.",
  worker:
    "You are the Worker. Execute only the supplied task using its relevant context. Stay within allowed authority, never perform prohibited work, and request escalation for approval-required or out-of-authority decisions. Return a result and compressed structured report, not raw logs.",
  evaluator:
    "You are the Evaluator. Assess the supplied task result against the task success criteria. A pass must recommend complete. A failure must give reasons and recommend exactly retry, replan, escalate, or fail. Return only the requested structured output.",
} as const;

function serializeForProvider(value: unknown): z.infer<typeof JsonValueSchema> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("LLM input is not JSON serializable");
  }
  return JsonValueSchema.parse(JSON.parse(serialized) as unknown);
}

function outputSchemaFor(schema: z.ZodType): z.infer<typeof JsonValueSchema> {
  return JsonValueSchema.parse(z.toJSONSchema(schema));
}

function normalizeProviderOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;
  return JSON.parse(output) as unknown;
}

async function generateAndParse<T>(
  provider: StructuredLlmProvider,
  request: Omit<StructuredLlmRequest, "outputSchema">,
  schema: z.ZodType<T>,
): Promise<T> {
  const output = await provider.generate({
    ...request,
    outputSchema: outputSchemaFor(schema),
  });
  return schema.parse(normalizeProviderOutput(output));
}

function makeRequest(
  role: StructuredLlmRequest["role"],
  operation: LlmOperation,
  system: string,
  input: unknown,
  schemaName: string,
): Omit<StructuredLlmRequest, "outputSchema"> {
  return {
    role,
    operation,
    system,
    input: serializeForProvider(input),
    schemaName,
  };
}

export class LlmCommanderAgent implements CommanderAgent {
  public constructor(
    private readonly provider: StructuredLlmProvider,
    public readonly id = "llm-commander",
  ) {}

  public createMission(goal: Goal): Promise<MissionProposal> {
    return generateAndParse(
      this.provider,
      makeRequest(
        "commander",
        "create-mission",
        SYSTEM_PROMPTS.commander,
        { goal },
        "mission_proposal",
      ),
      MissionProposalSchema,
    );
  }
}

export class LlmLeadAgent implements LeadAgent {
  public constructor(
    private readonly provider: StructuredLlmProvider,
    public readonly id = "llm-lead",
  ) {}

  public plan(mission: Mission): Promise<TaskPlan> {
    const input = LeadPlanInputSchema.parse({ mission });
    return generateAndParse(
      this.provider,
      makeRequest(
        "lead",
        "plan",
        SYSTEM_PROMPTS.lead,
        input,
        "task_plan",
      ),
      TaskPlanSchema,
    );
  }

  public replan(mission: Mission, context: ReplanContext): Promise<TaskPlan> {
    const input = LeadReplanInputSchema.parse({ mission, context });
    return generateAndParse(
      this.provider,
      makeRequest(
        "lead",
        "replan",
        SYSTEM_PROMPTS.lead,
        input,
        "task_plan",
      ),
      TaskPlanSchema,
    );
  }
}

export class LlmWorkerAgent implements WorkerAgent {
  public constructor(
    private readonly provider: StructuredLlmProvider,
    public readonly id = "llm-worker",
  ) {}

  public execute(task: Task, context: WorkerContext): Promise<TaskResult> {
    const input = WorkerExecutionInputSchema.parse({ task, context });
    return generateAndParse(
      this.provider,
      makeRequest(
        "worker",
        "execute-task",
        SYSTEM_PROMPTS.worker,
        input,
        "task_result",
      ),
      TaskResultSchema,
    );
  }
}

export class LlmEvaluatorAgent implements EvaluatorAgent {
  public constructor(
    private readonly provider: StructuredLlmProvider,
    public readonly id = "llm-evaluator",
  ) {}

  public evaluate(
    task: Task,
    result: TaskResult,
  ): Promise<EvaluationProposal> {
    const input = EvaluatorInputSchema.parse({ task, result });
    return generateAndParse(
      this.provider,
      makeRequest(
        "evaluator",
        "evaluate-task",
        SYSTEM_PROMPTS.evaluator,
        {
          task: input.task,
          successCriteria: task.successCriteria,
          result: input.result,
        },
        "evaluation",
      ),
      EvaluationProposalSchema,
    );
  }
}
