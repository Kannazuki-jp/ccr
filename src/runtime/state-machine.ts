import type { MissionStatus, TaskStatus } from "../domain/index.js";

export const missionTransitionMap = {
  created: ["planning", "cancelled"],
  planning: ["executing", "blocked", "escalated", "failed", "cancelled"],
  executing: ["evaluating", "blocked", "escalated", "failed", "cancelled"],
  evaluating: [
    "executing",
    "replanning",
    "blocked",
    "escalated",
    "completed",
    "failed",
    "cancelled",
  ],
  replanning: ["executing", "blocked", "escalated", "failed", "cancelled"],
  blocked: [
    "planning",
    "executing",
    "evaluating",
    "replanning",
    "escalated",
    "failed",
    "cancelled",
  ],
  escalated: [
    "planning",
    "executing",
    "evaluating",
    "replanning",
    "blocked",
    "failed",
    "cancelled",
  ],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<MissionStatus, readonly MissionStatus[]>;

export const taskTransitionMap = {
  pending: ["running", "blocked", "cancelled"],
  running: ["evaluating", "blocked", "failed", "cancelled"],
  evaluating: ["pending", "completed", "blocked", "failed", "cancelled"],
  blocked: ["pending", "running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<TaskStatus, readonly TaskStatus[]>;

export type StateEntity = "mission" | "task";

export class InvalidStateTransitionError extends Error {
  readonly entity: StateEntity;
  readonly from: MissionStatus | TaskStatus;
  readonly to: MissionStatus | TaskStatus;

  constructor(
    entity: StateEntity,
    from: MissionStatus | TaskStatus,
    to: MissionStatus | TaskStatus,
  ) {
    super(`Invalid ${entity} state transition: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

export function canTransitionMission(from: MissionStatus, to: MissionStatus): boolean {
  return (missionTransitionMap[from] as readonly MissionStatus[]).includes(to);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return (taskTransitionMap[from] as readonly TaskStatus[]).includes(to);
}

export function assertMissionTransition(from: MissionStatus, to: MissionStatus): void {
  if (!canTransitionMission(from, to)) {
    throw new InvalidStateTransitionError("mission", from, to);
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new InvalidStateTransitionError("task", from, to);
  }
}
