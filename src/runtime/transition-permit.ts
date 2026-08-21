/**
 * @file Doctrine が許可した一度限りの状態遷移 capability を管理します。
 *
 * このモジュールは package の公開 entry point から export しません。
 * SqliteStore は permit の内容を推測せず、ここで発行・消費を検証します。
 */

import type {
  AuthorizationResult,
  DecisionRequest,
  Event,
  MissionStatus,
  TaskStatus,
} from "../domain/index.js";
import {
  consumeRuntimeTransitionAuthorization,
  consumeTaskAssignmentAuthorization,
} from "./doctrine/enforcer.js";

export type TransitionEvidence = {
  readonly reportId: string;
  readonly evaluationResult: "pass";
};

type TransitionClaims = {
  readonly entity: "mission" | "task";
  readonly entityId: string;
  readonly missionId: string;
  readonly from: MissionStatus | TaskStatus;
  readonly to: MissionStatus | TaskStatus;
  readonly eventId: string;
  readonly evidence?: TransitionEvidence;
  readonly attempts?: number;
};

type AssignmentClaims = {
  readonly missionId: string;
  readonly taskId: string;
  readonly workerAgentId: string;
  readonly eventId: string;
};

/** Opaque, one-shot capability. Runtime code receives it only after ALLOW. */
export interface RuntimeTransitionPermit {
  readonly __runtimeTransitionPermit: unique symbol;
}

export interface TaskAssignmentPermit {
  readonly __taskAssignmentPermit: unique symbol;
}

const issued = new WeakMap<object, TransitionClaims>();
const assignments = new WeakMap<object, AssignmentClaims>();

export class ProtectedStateTransitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProtectedStateTransitionError";
  }
}

export function issueRuntimeTransitionPermit(
  request: DecisionRequest,
  authorization: AuthorizationResult,
  event: Event,
): RuntimeTransitionPermit {
  if (
    authorization.result !== "allow" ||
    !consumeRuntimeTransitionAuthorization(request, authorization) ||
    request.actorId !== "runtime" ||
    request.role !== "runtime" ||
    request.decisionType !== "state.transition"
  ) {
    throw new ProtectedStateTransitionError(
      "A state transition permit requires an ALLOW for runtime state.transition",
    );
  }

  const context = request.context;
  const entity = context?.entity;
  const entityId = context?.entityId;
  const from = context?.from;
  const to = context?.to;
  if (
    (entity !== "mission" && entity !== "task") ||
    typeof entityId !== "string" ||
    typeof from !== "string" ||
    typeof to !== "string" ||
    event.missionId !== request.missionId
  ) {
    throw new ProtectedStateTransitionError(
      "The authorized state transition is missing bound entity claims",
    );
  }

  const evaluationResult = context?.evaluationResult;
  const reportId = context?.reportId;
  const evidence =
    evaluationResult === "pass" && typeof reportId === "string"
      ? { reportId, evaluationResult } as const
      : undefined;
  const attempts = context?.attempts;
  const permit = Object.freeze({}) as RuntimeTransitionPermit;
  issued.set(permit, {
    entity,
    entityId,
    missionId: request.missionId,
    from: from as MissionStatus | TaskStatus,
    to: to as MissionStatus | TaskStatus,
    eventId: event.id,
    ...(evidence === undefined ? {} : { evidence }),
    ...(typeof attempts === "number" && Number.isInteger(attempts)
      ? { attempts }
      : {}),
  });
  return permit;
}

export function consumeRuntimeTransitionPermit(
  permit: RuntimeTransitionPermit | undefined,
  expected: Omit<TransitionClaims, "evidence">,
): Pick<TransitionClaims, "evidence" | "attempts"> {
  if (permit === undefined) {
    throw new ProtectedStateTransitionError(
      "Direct state transition rejected: an authorized Runtime permit is required",
    );
  }
  const claims = issued.get(permit);
  if (claims === undefined) {
    throw new ProtectedStateTransitionError(
      "State transition permit is invalid or has already been consumed",
    );
  }
  issued.delete(permit);
  if (
    claims.entity !== expected.entity ||
    claims.entityId !== expected.entityId ||
    claims.missionId !== expected.missionId ||
    claims.from !== expected.from ||
    claims.to !== expected.to ||
    claims.eventId !== expected.eventId
  ) {
    throw new ProtectedStateTransitionError(
      "State transition permit does not match the requested transition",
    );
  }
  return {
    ...(claims.evidence === undefined ? {} : { evidence: claims.evidence }),
    ...(claims.attempts === undefined ? {} : { attempts: claims.attempts }),
  };
}


export function issueTaskAssignmentPermit(
  request: DecisionRequest,
  authorization: AuthorizationResult,
  event: Event,
): TaskAssignmentPermit {
  const workerAgentId = request.context?.workerAgentId;
  if (
    authorization.result !== "allow" ||
    !consumeTaskAssignmentAuthorization(request, authorization) ||
    request.role !== "lead" ||
    request.decisionType !== "task.assign" ||
    request.taskId === undefined ||
    typeof workerAgentId !== "string" ||
    event.missionId !== request.missionId
  ) {
    throw new ProtectedStateTransitionError(
      "A Task assignment permit requires a genuine Lead task.assign ALLOW",
    );
  }
  const permit = Object.freeze({}) as TaskAssignmentPermit;
  assignments.set(permit, {
    missionId: request.missionId,
    taskId: request.taskId,
    workerAgentId,
    eventId: event.id,
  });
  return permit;
}

export function consumeTaskAssignmentPermit(
  permit: TaskAssignmentPermit | undefined,
  expected: AssignmentClaims,
): void {
  if (permit === undefined) {
    throw new ProtectedStateTransitionError(
      "Direct Task assignment rejected: an authorized Lead permit is required",
    );
  }
  const claims = assignments.get(permit);
  assignments.delete(permit);
  if (
    claims === undefined ||
    claims.missionId !== expected.missionId ||
    claims.taskId !== expected.taskId ||
    claims.workerAgentId !== expected.workerAgentId ||
    claims.eventId !== expected.eventId
  ) {
    throw new ProtectedStateTransitionError(
      "Task assignment permit does not match the requested assignment",
    );
  }
}
