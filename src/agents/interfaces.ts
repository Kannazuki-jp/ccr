/**
 * @file C2 ランタイムで各役割のエージェントが満たす共通インターフェースを定義します。
 */

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

export interface RuntimeAgent {
  readonly id: string;
}

export interface CommanderAgent extends RuntimeAgent {
  createMission(goal: Goal): Promise<MissionProposal>;
}

export interface LeadAgent extends RuntimeAgent {
  plan(mission: Mission): Promise<TaskPlan>;
  replan(mission: Mission, context: ReplanContext): Promise<TaskPlan>;
}

export interface WorkerAgent extends RuntimeAgent {
  execute(task: Task, context: WorkerContext): Promise<TaskResult>;
}

export interface EvaluatorAgent extends RuntimeAgent {
  evaluate(task: Task, result: TaskResult): Promise<EvaluationProposal>;
}

export interface RuntimeAgents {
  readonly commander: CommanderAgent;
  readonly lead: LeadAgent;
  readonly worker: WorkerAgent;
  readonly evaluator: EvaluatorAgent;
}
