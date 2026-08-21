/**
 * @file C2 の状態と履歴を SQLite に検証付きで永続化するストアを実装します。
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AgentRecordSchema,
  AuthorityGrantSchema,
  AuthorizationRecordSchema,
  ConstraintSchema,
  DecisionSchema,
  DoctrineViolationRecordSchema,
  EscalationRecordSchema,
  EventSchema,
  MissionSchema,
  ReportSchema,
  RiskLimitSchema,
  TaskSchema,
  type AgentRecord,
  type AuthorityGrant,
  type AuthorizationRecord,
  type Constraint,
  type Decision,
  type DoctrineViolationRecord,
  type EscalationRecord,
  type Event,
  type Mission,
  type MissionStatus,
  type Report,
  type RiskLimit,
  type Task,
  type TaskStatus,
} from "../../domain/index.js";
import { assertMissionTransition, assertTaskTransition } from "../../runtime/state-machine.js";
import {
  consumeTaskAssignmentPermit,
  consumeRuntimeTransitionPermit,
  ProtectedStateTransitionError,
  type RuntimeTransitionPermit,
  type TaskAssignmentPermit,
} from "../../runtime/transition-permit.js";

export { ProtectedStateTransitionError } from "../../runtime/transition-permit.js";

type JsonRow = { readonly data: string };

const DATE_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "expiresAt",
  "revokedAt",
  "resolvedAt",
]);

function serialize(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("Cannot persist an undefined value");
  }
  return json;
}

function hydrate<T>(json: string): T {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return parsed as T;
  }

  const record = parsed as Record<string, unknown>;
  for (const key of DATE_KEYS) {
    const value = record[key];
    if (typeof value === "string") {
      record[key] = new Date(value);
    }
  }
  return record as T;
}

function rowData<T>(row: unknown): T | undefined {
  if (row === undefined) {
    return undefined;
  }
  return hydrate<T>((row as JsonRow).data);
}

function allRowData<T>(rows: readonly unknown[]): T[] {
  return rows.map((row) => hydrate<T>((row as JsonRow).data));
}

export class EntityNotFoundError extends Error {
  readonly entity: "mission" | "task";
  readonly id: string;

  constructor(entity: "mission" | "task", id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "EntityNotFoundError";
    this.entity = entity;
    this.id = id;
  }
}

export class TransitionEventMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionEventMismatchError";
  }
}

export class DirectStateMutationError extends Error {
  constructor(entity: "mission" | "task", id: string, from: string, to: string) {
    super(
      `Direct ${entity} status mutation is prohibited for ${id}: ${from} -> ${to}`,
    );
    this.name = "DirectStateMutationError";
  }
}

export class TransitionEventTimestampError extends Error {
  constructor(entity: "mission" | "task", id: string) {
    super(`Transition event timestamp precedes current ${entity} state: ${id}`);
    this.name = "TransitionEventTimestampError";
  }
}

export class AuthorityGrantLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityGrantLifecycleError";
  }
}

export class EscalationLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscalationLifecycleError";
  }
}

export class DoctrineAuditEventMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoctrineAuditEventMismatchError";
  }
}

export type MissionSnapshot = {
  mission: Mission;
  tasks: Task[];
  reports: Report[];
  decisions: Decision[];
  authorityGrants: AuthorityGrant[];
  constraints: Constraint[];
  riskLimits: RiskLimit[];
  authorizationRecords: AuthorizationRecord[];
  doctrineViolations: DoctrineViolationRecord[];
  escalations: EscalationRecord[];
  events: Event[];
};

export type RuntimeSnapshot = {
  missions: Mission[];
  tasks: Task[];
  agents: AgentRecord[];
  reports: Report[];
  decisions: Decision[];
  authorityGrants: AuthorityGrant[];
  constraints: Constraint[];
  riskLimits: RiskLimit[];
  authorizationRecords: AuthorizationRecord[];
  doctrineViolations: DoctrineViolationRecord[];
  escalations: EscalationRecord[];
  events: Event[];
};

export type SqliteAuthorizationAudit = {
  readonly record: AuthorizationRecord;
  readonly event: Event;
};

export type SqliteAuthorityGrantAudit = {
  readonly grant: AuthorityGrant;
  readonly grantEvent: Event;
  readonly constraintEvents: readonly Event[];
  readonly authorization: SqliteAuthorizationAudit;
};

export type SqliteAuthorityRevocationAudit = {
  readonly grantId: string;
  readonly revokedAt: Date;
  readonly revokeEvent: Event;
  readonly authorization: SqliteAuthorizationAudit;
};

export type SqliteEscalationAudit = {
  readonly escalation: EscalationRecord;
  readonly escalationEvent: Event;
  readonly authorization: SqliteAuthorizationAudit;
};

export type SqliteDoctrineDenialAudit = {
  readonly violation: DoctrineViolationRecord;
  readonly violationEvent: Event;
  readonly relatedEvents: readonly Event[];
  readonly authorization: SqliteAuthorizationAudit;
};

/**
 * プロトタイプランタイム向けの同期 SQLite 永続化ストアです。
 *
 * 各行には検索に必要な識別子と正規化済み JSON スナップショットを保存します。
 * ランタイムの状態遷移では明示的なトランザクションを使い、更新後の集約とイベントを同時に確定またはロールバックします。
 */
export class SqliteStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(filename = ":memory:") {
    if (filename !== ":memory:" && !filename.startsWith("file:")) {
      mkdirSync(dirname(resolve(filename)), { recursive: true });
    }

    this.#database = new DatabaseSync(filename, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.#migrate();
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  saveMission(mission: Mission): void {
    const validated = MissionSchema.parse(mission);
    const existing = this.getMission(validated.id);
    if (existing !== undefined) {
      throw new DirectStateMutationError(
        "mission",
        validated.id,
        existing.status,
        validated.status,
      );
    }
    this.#upsertMission(validated);
  }

  #upsertMission(mission: Mission): void {
    this.#database
      .prepare(`
        INSERT INTO missions (id, status, created_at, updated_at, data)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          data = excluded.data
      `)
      .run(
        mission.id,
        mission.status,
        mission.createdAt.toISOString(),
        mission.updatedAt.toISOString(),
        serialize(mission),
      );
  }

  getMission(id: string): Mission | undefined {
    const mission = rowData<Mission>(
      this.#database.prepare("SELECT data FROM missions WHERE id = ?").get(id),
    );
    return mission === undefined ? undefined : MissionSchema.parse(mission);
  }

  listMissions(): Mission[] {
    return allRowData<Mission>(
      this.#database.prepare("SELECT data FROM missions ORDER BY created_at, id").all(),
    ).map((mission) => MissionSchema.parse(mission));
  }

  saveTask(task: Task): void {
    const validated = TaskSchema.parse(task);
    const existing = this.getTask(validated.id);
    if (existing !== undefined) {
      throw new DirectStateMutationError(
        "task",
        validated.id,
        existing.status,
        validated.status,
      );
    }
    this.#upsertTask(validated);
  }

  assignTaskAndEvent(
    taskId: string,
    workerAgentId: string,
    event: Event,
    permit?: TaskAssignmentPermit,
  ): Task {
    return this.#transaction(() => {
      const task = this.getTask(taskId);
      if (task === undefined) throw new EntityNotFoundError("task", taskId);
      if (task.status !== "pending" || task.assignedAgentId !== undefined) {
        throw new ProtectedStateTransitionError(
          `Task ${taskId} is not an unassigned pending Task`,
        );
      }
      if (event.missionId !== task.missionId || event.type !== "TaskAssigned") {
        throw new TransitionEventMismatchError(
          `Task assignment event does not match Task ${taskId}`,
        );
      }
      const worker = this.getAgent(workerAgentId);
      if (worker?.role !== "worker") {
        throw new ProtectedStateTransitionError(
          `Task ${taskId} may only be assigned to a registered Worker`,
        );
      }
      consumeTaskAssignmentPermit(permit, {
        missionId: task.missionId,
        taskId,
        workerAgentId,
        eventId: event.id,
      });
      const updated = TaskSchema.parse({ ...task, assignedAgentId: workerAgentId });
      this.#upsertTask(updated);
      this.appendEvent(event);
      return updated;
    });
  }

  #upsertTask(task: Task): void {
    this.#database
      .prepare(`
        INSERT INTO tasks (id, mission_id, status, created_at, updated_at, data)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          mission_id = excluded.mission_id,
          status = excluded.status,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          data = excluded.data
      `)
      .run(
        task.id,
        task.missionId,
        task.status,
        task.createdAt.toISOString(),
        task.updatedAt.toISOString(),
        serialize(task),
      );
  }

  getTask(id: string): Task | undefined {
    const task = rowData<Task>(
      this.#database.prepare("SELECT data FROM tasks WHERE id = ?").get(id),
    );
    return task === undefined ? undefined : TaskSchema.parse(task);
  }

  listTasks(missionId?: string): Task[] {
    const rows = missionId === undefined
      ? this.#database.prepare("SELECT data FROM tasks ORDER BY created_at, id").all()
      : this.#database
          .prepare("SELECT data FROM tasks WHERE mission_id = ? ORDER BY created_at, id")
          .all(missionId);
    return allRowData<Task>(rows).map((task) => TaskSchema.parse(task));
  }

  saveAgent(agent: AgentRecord): void {
    agent = AgentRecordSchema.parse(agent);
    this.#database
      .prepare(`
        INSERT INTO agents (id, role, created_at, updated_at, data)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          role = excluded.role,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          data = excluded.data
      `)
      .run(
        agent.id,
        agent.role,
        agent.createdAt.toISOString(),
        agent.updatedAt.toISOString(),
        serialize(agent),
      );
  }

  getAgent(id: string): AgentRecord | undefined {
    const agent = rowData<AgentRecord>(
      this.#database.prepare("SELECT data FROM agents WHERE id = ?").get(id),
    );
    return agent === undefined ? undefined : AgentRecordSchema.parse(agent);
  }

  listAgents(): AgentRecord[] {
    return allRowData<AgentRecord>(
      this.#database.prepare("SELECT data FROM agents ORDER BY created_at, id").all(),
    ).map((agent) => AgentRecordSchema.parse(agent));
  }

  saveReport(report: Report): void {
    report = ReportSchema.parse(report);
    this.#database
      .prepare(`
        INSERT INTO reports (id, mission_id, task_id, agent_id, created_at, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        report.id,
        report.missionId,
        report.taskId,
        report.agentId,
        report.createdAt.toISOString(),
        serialize(report),
      );
  }

  listReports(missionId?: string, taskId?: string): Report[] {
    let rows: unknown[];
    if (missionId !== undefined && taskId !== undefined) {
      rows = this.#database
        .prepare(`
          SELECT data FROM reports
          WHERE mission_id = ? AND task_id = ?
          ORDER BY created_at, id
        `)
        .all(missionId, taskId);
    } else if (missionId !== undefined) {
      rows = this.#database
        .prepare("SELECT data FROM reports WHERE mission_id = ? ORDER BY created_at, id")
        .all(missionId);
    } else if (taskId !== undefined) {
      rows = this.#database
        .prepare("SELECT data FROM reports WHERE task_id = ? ORDER BY created_at, id")
        .all(taskId);
    } else {
      rows = this.#database.prepare("SELECT data FROM reports ORDER BY created_at, id").all();
    }
    return allRowData<Report>(rows).map((report) => ReportSchema.parse(report));
  }

  saveDecision(decision: Decision): void {
    decision = DecisionSchema.parse(decision);
    this.#database
      .prepare(`
        INSERT INTO decisions (id, mission_id, task_id, created_at, data)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        decision.id,
        decision.missionId,
        decision.taskId ?? null,
        decision.createdAt.toISOString(),
        serialize(decision),
      );
  }

  listDecisions(missionId?: string): Decision[] {
    const rows = missionId === undefined
      ? this.#database.prepare("SELECT data FROM decisions ORDER BY created_at, id").all()
      : this.#database
          .prepare("SELECT data FROM decisions WHERE mission_id = ? ORDER BY created_at, id")
          .all(missionId);
    return allRowData<Decision>(rows).map((decision) =>
      DecisionSchema.parse(decision),
    );
  }

  grantAuthority(grant: AuthorityGrant, event: Event): void {
    const validatedGrant = AuthorityGrantSchema.parse(grant);
    const validatedEvent = EventSchema.parse(event);
    if (validatedGrant.status !== "active") {
      throw new AuthorityGrantLifecycleError(
        `A new authority grant must be active: ${validatedGrant.id}`,
      );
    }
    this.#assertDoctrineEvent(
      validatedGrant.missionId,
      validatedEvent,
      "AuthorityGranted",
    );
    if (validatedEvent.createdAt < validatedGrant.createdAt) {
      throw new DoctrineAuditEventMismatchError(
        `AuthorityGranted event precedes grant creation: ${validatedGrant.id}`,
      );
    }
    this.#transaction(() => {
      this.#insertAuthorityGrant(validatedGrant);
      this.#appendValidatedEvent(validatedEvent);
    });
  }

  grantAuthorityWithAudit(input: SqliteAuthorityGrantAudit): void {
    const grant = AuthorityGrantSchema.parse(input.grant);
    const grantEvent = EventSchema.parse(input.grantEvent);
    const constraintEvents = input.constraintEvents.map((event) =>
      EventSchema.parse(event)
    );
    const authorization = this.#validateAuthorizationAudit(
      input.authorization,
    );
    if (grant.status !== "active") {
      throw new AuthorityGrantLifecycleError(
        `A new authority grant must be active: ${grant.id}`,
      );
    }
    this.#assertDoctrineEvent(grant.missionId, grantEvent, "AuthorityGranted");
    this.#assertEventPayloadReference(
      grantEvent,
      "grantId",
      grant.id,
      "AuthorityGranted",
    );
    this.#assertAuditEventTime(
      grant.createdAt,
      grantEvent,
      "authority grant",
      grant.id,
    );
    this.#assertConstraintEvents(grant, constraintEvents);
    this.#assertAuthorizationForMutation(
      authorization.record,
      grant.missionId,
      "allow",
      "authority.delegate",
      grant.taskId,
    );
    this.#assertEventPayloadReference(
      authorization.event,
      "requestId",
      authorization.record.requestId,
      "authorization",
    );

    this.#transaction(() => {
      this.#insertAuthorityGrant(grant);
      this.#appendValidatedEvent(grantEvent);
      for (const constraintEvent of constraintEvents) {
        this.#appendValidatedEvent(constraintEvent);
      }
      this.#insertAuthorizationAudit(authorization);
    });
  }

  #assertConstraintEvents(
    grant: AuthorityGrant,
    events: readonly Event[],
  ): void {
    if (events.length !== grant.constraints.length) {
      throw new DoctrineAuditEventMismatchError(
        `Expected ${grant.constraints.length} ConstraintApplied event(s) ` +
        `for grant ${grant.id}, received ${events.length}`,
      );
    }
    grant.constraints.forEach((constraint, index) => {
      const event = events[index]!;
      this.#assertDoctrineEvent(grant.missionId, event, "ConstraintApplied");
      this.#assertAuditEventTime(
        grant.createdAt,
        event,
        "constraint application",
        constraint.id,
      );
      if (
        typeof event.payload !== "object" ||
        event.payload === null ||
        Array.isArray(event.payload) ||
        event.payload.constraintId !== constraint.id ||
        event.payload.grantId !== grant.id
      ) {
        throw new DoctrineAuditEventMismatchError(
          `ConstraintApplied event does not identify ${constraint.id} ` +
          `on grant ${grant.id}`,
        );
      }
    });
  }

  #insertAuthorityGrant(grant: AuthorityGrant): void {
    this.#database
      .prepare(`
        INSERT INTO authority_grants (
          id, issuer_id, subject_id, mission_id, task_id,
          permissions_json, constraints_json, risk_limits_json,
          status, created_at, expires_at, revoked_at, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        grant.id,
        grant.issuerId,
        grant.subjectId,
        grant.missionId,
        grant.taskId ?? null,
        serialize(grant.permissions),
        serialize(grant.constraints),
        serialize(grant.riskLimits),
        grant.status,
        grant.createdAt.toISOString(),
        grant.expiresAt?.toISOString() ?? null,
        grant.revokedAt?.toISOString() ?? null,
        serialize(grant),
      );

    const constraintStatement = this.#database.prepare(`
      INSERT INTO constraints (
        grant_id, position, constraint_id, mission_id, subject_id, data
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    grant.constraints.forEach((constraint, position) => {
      constraintStatement.run(
        grant.id,
        position,
        constraint.id,
        grant.missionId,
        grant.subjectId,
        serialize(constraint),
      );
    });

    const riskLimitStatement = this.#database.prepare(`
      INSERT INTO risk_limits (
        grant_id, position, mission_id, subject_id,
        dimension, operator, value, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    grant.riskLimits.forEach((riskLimit, position) => {
      riskLimitStatement.run(
        grant.id,
        position,
        grant.missionId,
        grant.subjectId,
        riskLimit.dimension,
        riskLimit.operator,
        riskLimit.value,
        serialize(riskLimit),
      );
    });
  }

  getAuthorityGrant(id: string): AuthorityGrant | undefined {
    const grant = rowData<AuthorityGrant>(
      this.#database
        .prepare("SELECT data FROM authority_grants WHERE id = ?")
        .get(id),
    );
    return grant === undefined ? undefined : AuthorityGrantSchema.parse(grant);
  }

  listAuthorityGrants(missionId?: string, subjectId?: string): AuthorityGrant[] {
    const missionFilter = missionId ?? null;
    const subjectFilter = subjectId ?? null;
    return allRowData<AuthorityGrant>(
      this.#database
        .prepare(`
          SELECT data FROM authority_grants
          WHERE (? IS NULL OR mission_id = ?)
            AND (? IS NULL OR subject_id = ?)
          ORDER BY created_at, id
        `)
        .all(missionFilter, missionFilter, subjectFilter, subjectFilter),
    ).map((grant) => AuthorityGrantSchema.parse(grant));
  }

  listConstraints(missionId?: string, subjectId?: string): Constraint[] {
    const missionFilter = missionId ?? null;
    const subjectFilter = subjectId ?? null;
    return allRowData<Constraint>(
      this.#database
        .prepare(`
          SELECT data FROM constraints
          WHERE (? IS NULL OR mission_id = ?)
            AND (? IS NULL OR subject_id = ?)
          ORDER BY grant_id, position
        `)
        .all(missionFilter, missionFilter, subjectFilter, subjectFilter),
    ).map((constraint) => ConstraintSchema.parse(constraint));
  }

  listRiskLimits(missionId?: string, subjectId?: string): RiskLimit[] {
    const missionFilter = missionId ?? null;
    const subjectFilter = subjectId ?? null;
    return allRowData<RiskLimit>(
      this.#database
        .prepare(`
          SELECT data FROM risk_limits
          WHERE (? IS NULL OR mission_id = ?)
            AND (? IS NULL OR subject_id = ?)
          ORDER BY grant_id, position
        `)
        .all(missionFilter, missionFilter, subjectFilter, subjectFilter),
    ).map((riskLimit) => RiskLimitSchema.parse(riskLimit));
  }

  revokeAuthorityGrant(grantId: string, revokedAt: Date, event: Event): AuthorityGrant {
    const validatedEvent = EventSchema.parse(event);
    return this.#transaction(() => {
      const grant = this.#requireActiveAuthorityGrant(grantId);
      this.#assertDoctrineEvent(grant.missionId, validatedEvent, "AuthorityRevoked");
      if (validatedEvent.createdAt < revokedAt) {
        throw new DoctrineAuditEventMismatchError(
          `Authority revocation event precedes its state change: ${grantId}`,
        );
      }
      if (revokedAt < grant.createdAt) {
        throw new AuthorityGrantLifecycleError(
          `Authority revocation precedes grant creation: ${grantId}`,
        );
      }
      const updated = AuthorityGrantSchema.parse({
        ...grant,
        status: "revoked",
        revokedAt: new Date(revokedAt),
      });
      this.#assertAuthorityGrantLifecycleUpdate(grant, updated);
      this.#updateAuthorityGrantLifecycle(updated);
      this.#appendValidatedEvent(validatedEvent);
      return updated;
    });
  }

  revokeAuthorityGrantWithAudit(
    input: SqliteAuthorityRevocationAudit,
  ): AuthorityGrant {
    const revokeEvent = EventSchema.parse(input.revokeEvent);
    const authorization = this.#validateAuthorizationAudit(
      input.authorization,
    );
    return this.#transaction(() => {
      const grant = this.#requireActiveAuthorityGrant(input.grantId);
      this.#assertDoctrineEvent(
        grant.missionId,
        revokeEvent,
        "AuthorityRevoked",
      );
      this.#assertEventPayloadReference(
        revokeEvent,
        "grantId",
        grant.id,
        "AuthorityRevoked",
      );
      if (revokeEvent.createdAt < input.revokedAt) {
        throw new DoctrineAuditEventMismatchError(
          `Authority revocation event precedes its state change: ${grant.id}`,
        );
      }
      if (input.revokedAt < grant.createdAt) {
        throw new AuthorityGrantLifecycleError(
          `Authority revocation precedes grant creation: ${grant.id}`,
        );
      }
      this.#assertAuthorizationForMutation(
        authorization.record,
        grant.missionId,
        "allow",
        "authority.revoke",
        grant.taskId,
      );
      this.#assertEventPayloadReference(
        authorization.event,
        "requestId",
        authorization.record.requestId,
        "authorization",
      );
      const updated = AuthorityGrantSchema.parse({
        ...grant,
        status: "revoked",
        revokedAt: new Date(input.revokedAt),
      });
      this.#assertAuthorityGrantLifecycleUpdate(grant, updated);
      this.#updateAuthorityGrantLifecycle(updated);
      this.#appendValidatedEvent(revokeEvent);
      this.#insertAuthorizationAudit(authorization);
      return updated;
    });
  }

  expireAuthorityGrant(grantId: string, event: Event): AuthorityGrant {
    const validatedEvent = EventSchema.parse(event);
    return this.#transaction(() => {
      const grant = this.#requireActiveAuthorityGrant(grantId);
      this.#assertDoctrineEvent(grant.missionId, validatedEvent, "AuthorityExpired");
      if (grant.expiresAt === undefined) {
        throw new AuthorityGrantLifecycleError(
          `Authority grant has no expiration: ${grantId}`,
        );
      }
      if (validatedEvent.createdAt < grant.expiresAt) {
        throw new AuthorityGrantLifecycleError(
          `Authority grant has not expired yet: ${grantId}`,
        );
      }
      const updated = AuthorityGrantSchema.parse({
        ...grant,
        status: "expired",
      });
      this.#assertAuthorityGrantLifecycleUpdate(grant, updated);
      this.#updateAuthorityGrantLifecycle(updated);
      this.#appendValidatedEvent(validatedEvent);
      return updated;
    });
  }

  #requireActiveAuthorityGrant(grantId: string): AuthorityGrant {
    const grant = this.getAuthorityGrant(grantId);
    if (grant === undefined) {
      throw new AuthorityGrantLifecycleError(
        `Authority grant not found: ${grantId}`,
      );
    }
    if (grant.status !== "active") {
      throw new AuthorityGrantLifecycleError(
        `Authority grant is not active: ${grantId} (${grant.status})`,
      );
    }
    return grant;
  }

  #assertAuthorityGrantLifecycleUpdate(
    existing: AuthorityGrant,
    updated: AuthorityGrant,
  ): void {
    if (updated.status !== "revoked" && updated.status !== "expired") {
      throw new AuthorityGrantLifecycleError(
        `Authority grant must transition from active to revoked or expired: ${existing.id}`,
      );
    }
    const immutableKeys = [
      "id",
      "issuerId",
      "subjectId",
      "missionId",
      "taskId",
      "createdAt",
      "expiresAt",
    ] as const;
    for (const key of immutableKeys) {
      const before = existing[key];
      const after = updated[key];
      const equal = before instanceof Date && after instanceof Date
        ? before.getTime() === after.getTime()
        : before === after;
      if (!equal) {
        throw new AuthorityGrantLifecycleError(
          `Authority grant field is immutable: ${existing.id}.${key}`,
        );
      }
    }
    for (const key of ["permissions", "constraints", "riskLimits"] as const) {
      if (serialize(existing[key]) !== serialize(updated[key])) {
        throw new AuthorityGrantLifecycleError(
          `Authority grant field is immutable: ${existing.id}.${key}`,
        );
      }
    }
  }

  #updateAuthorityGrantLifecycle(grant: AuthorityGrant): void {
    this.#database
      .prepare(`
        UPDATE authority_grants
        SET status = ?, revoked_at = ?, data = ?
        WHERE id = ?
      `)
      .run(
        grant.status,
        grant.revokedAt?.toISOString() ?? null,
        serialize(grant),
        grant.id,
      );
  }

  saveAuthorizationRecordAndEvent(record: AuthorizationRecord, event: Event): void {
    const authorization = this.#validateAuthorizationAudit({ record, event });
    this.#transaction(() => this.#insertAuthorizationAudit(authorization));
  }

  #validateAuthorizationAudit(
    input: SqliteAuthorizationAudit,
  ): SqliteAuthorizationAudit {
    const validatedRecord = AuthorizationRecordSchema.parse(input.record);
    const validatedEvent = EventSchema.parse(input.event);
    const expectedEvent = {
      allow: "AuthorizationAllowed",
      deny: "AuthorizationDenied",
      escalate: "AuthorizationEscalated",
    }[validatedRecord.result];
    this.#assertDoctrineEvent(
      validatedRecord.missionId,
      validatedEvent,
      expectedEvent,
    );
    this.#assertAuditEventTime(
      validatedRecord.createdAt,
      validatedEvent,
      "authorization result",
      validatedRecord.id,
    );
    return { record: validatedRecord, event: validatedEvent };
  }

  #insertAuthorizationAudit(authorization: SqliteAuthorizationAudit): void {
    this.#insertAuthorizationRecord(authorization.record);
    this.#appendValidatedEvent(authorization.event);
  }

  #assertAuthorizationForMutation(
    record: AuthorizationRecord,
    missionId: string,
    result: AuthorizationRecord["result"],
    decisionType: AuthorizationRecord["decisionType"],
    taskId?: string,
  ): void {
    if (
      record.missionId !== missionId ||
      record.taskId !== taskId ||
      record.result !== result ||
      record.decisionType !== decisionType
    ) {
      throw new DoctrineAuditEventMismatchError(
        `Authorization ${record.id} does not match ${decisionType} ` +
        `for mission ${missionId}`,
      );
    }
  }

  #insertAuthorizationRecord(record: AuthorizationRecord): void {
    this.#database
      .prepare(`
        INSERT INTO authorization_results (
          id, request_id, mission_id, task_id, actor_id,
          decision_type, result, created_at, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.requestId,
        record.missionId,
        record.taskId ?? null,
        record.actorId,
        record.decisionType,
        record.result,
        record.createdAt.toISOString(),
        serialize(record),
      );
  }

  listAuthorizationRecords(missionId?: string, actorId?: string): AuthorizationRecord[] {
    const missionFilter = missionId ?? null;
    const actorFilter = actorId ?? null;
    return allRowData<AuthorizationRecord>(
      this.#database
        .prepare(`
          SELECT data FROM authorization_results
          WHERE (? IS NULL OR mission_id = ?)
            AND (? IS NULL OR actor_id = ?)
          ORDER BY created_at, rowid
        `)
        .all(missionFilter, missionFilter, actorFilter, actorFilter),
    ).map((record) => AuthorizationRecordSchema.parse(record));
  }

  saveDoctrineViolationAndEvent(
    record: DoctrineViolationRecord,
    event: Event,
  ): void {
    const violation = this.#validateDoctrineViolationAudit(record, event);
    this.#transaction(() => this.#insertDoctrineViolationAudit(violation));
  }

  saveDoctrineDenialAudit(input: SqliteDoctrineDenialAudit): void {
    const violation = this.#validateDoctrineViolationAudit(
      input.violation,
      input.violationEvent,
    );
    const relatedEvents = input.relatedEvents.map((event) =>
      EventSchema.parse(event)
    );
    const authorization = this.#validateAuthorizationAudit(
      input.authorization,
    );
    this.#assertAuthorizationForMutation(
      authorization.record,
      violation.record.missionId,
      "deny",
      violation.record.decisionType,
      violation.record.taskId,
    );
    if (authorization.record.violation?.id !== violation.record.id) {
      throw new DoctrineAuditEventMismatchError(
        `Authorization ${authorization.record.id} does not reference ` +
        `violation ${violation.record.id}`,
      );
    }
    this.#assertEventPayloadReference(
      violation.event,
      "violationId",
      violation.record.id,
      "DoctrineViolationDetected",
    );
    this.#assertEventPayloadReference(
      authorization.event,
      "requestId",
      authorization.record.requestId,
      "authorization",
    );
    for (const event of relatedEvents) {
      if (
        event.missionId !== violation.record.missionId ||
        (event.type !== "ConstraintViolationDetected" &&
          event.type !== "RiskLimitExceeded")
      ) {
        throw new DoctrineAuditEventMismatchError(
          `Unexpected related violation event: ${event.type}`,
        );
      }
      this.#assertAuditEventTime(
        violation.record.createdAt,
        event,
        "doctrine violation",
        violation.record.id,
      );
      this.#assertEventPayloadReference(
        event,
        "violationId",
        violation.record.id,
        event.type,
      );
    }

    this.#transaction(() => {
      this.#insertDoctrineViolationAudit(violation);
      for (const event of relatedEvents) {
        this.#appendValidatedEvent(event);
      }
      this.#insertAuthorizationAudit(authorization);
    });
  }

  #validateDoctrineViolationAudit(
    record: DoctrineViolationRecord,
    event: Event,
  ): { readonly record: DoctrineViolationRecord; readonly event: Event } {
    const validatedRecord = DoctrineViolationRecordSchema.parse(record);
    const validatedEvent = EventSchema.parse(event);
    this.#assertDoctrineEvent(
      validatedRecord.missionId,
      validatedEvent,
      "DoctrineViolationDetected",
    );
    this.#assertAuditEventTime(
      validatedRecord.createdAt,
      validatedEvent,
      "doctrine violation",
      validatedRecord.id,
    );
    return { record: validatedRecord, event: validatedEvent };
  }

  #insertDoctrineViolationAudit(
    violation: { readonly record: DoctrineViolationRecord; readonly event: Event },
  ): void {
    this.#insertDoctrineViolation(violation.record);
    this.#appendValidatedEvent(violation.event);
  }

  #insertDoctrineViolation(record: DoctrineViolationRecord): void {
    this.#database
      .prepare(`
        INSERT INTO doctrine_violations (
          id, request_id, mission_id, task_id, actor_id,
          decision_type, code, created_at, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.requestId,
        record.missionId,
        record.taskId ?? null,
        record.actorId,
        record.decisionType,
        record.code,
        record.createdAt.toISOString(),
        serialize(record),
      );
  }

  listDoctrineViolations(
    missionId?: string,
    actorId?: string,
  ): DoctrineViolationRecord[] {
    const missionFilter = missionId ?? null;
    const actorFilter = actorId ?? null;
    return allRowData<DoctrineViolationRecord>(
      this.#database
        .prepare(`
          SELECT data FROM doctrine_violations
          WHERE (? IS NULL OR mission_id = ?)
            AND (? IS NULL OR actor_id = ?)
          ORDER BY created_at, rowid
        `)
        .all(missionFilter, missionFilter, actorFilter, actorFilter),
    ).map((record) => DoctrineViolationRecordSchema.parse(record));
  }

  saveEscalationAndEvent(escalation: EscalationRecord, event: Event): void {
    const validated = this.#validateEscalationAudit(escalation, event);
    this.#transaction(() => this.#insertEscalationAudit(validated));
  }

  saveEscalationWithAudit(input: SqliteEscalationAudit): void {
    const escalation = this.#validateEscalationAudit(
      input.escalation,
      input.escalationEvent,
    );
    const authorization = this.#validateAuthorizationAudit(
      input.authorization,
    );
    this.#assertAuthorizationForMutation(
      authorization.record,
      escalation.record.missionId,
      escalation.record.status === "open" ? "escalate" : "allow",
      escalation.record.decisionType,
      escalation.record.taskId,
    );
    if (
      escalation.record.status === "open" &&
      authorization.record.targetRole !== escalation.record.targetRole
    ) {
      throw new DoctrineAuditEventMismatchError(
        `Authorization ${authorization.record.id} does not target ` +
        `${escalation.record.targetRole}`,
      );
    }
    this.#assertEventPayloadReference(
      escalation.event,
      "escalationId",
      escalation.record.id,
      escalation.event.type,
    );
    this.#assertEventPayloadReference(
      authorization.event,
      "requestId",
      authorization.record.requestId,
      "authorization",
    );
    this.#transaction(() => {
      this.#insertEscalationAudit(escalation);
      this.#insertAuthorizationAudit(authorization);
    });
  }

  #validateEscalationAudit(
    escalation: EscalationRecord,
    event: Event,
  ): { readonly record: EscalationRecord; readonly event: Event } {
    const validatedEscalation = EscalationRecordSchema.parse(escalation);
    const validatedEvent = EventSchema.parse(event);
    this.#assertDoctrineEvent(
      validatedEscalation.missionId,
      validatedEvent,
      validatedEscalation.status === "open"
        ? "EscalationCreated"
        : "EscalationResolved",
    );
    const transitionAt = validatedEscalation.status === "open"
      ? validatedEscalation.createdAt
      : validatedEscalation.resolvedAt;
    if (transitionAt === undefined) {
      throw new EscalationLifecycleError(
        `Resolved escalation has no resolution timestamp: ${validatedEscalation.id}`,
      );
    }
    if (transitionAt < validatedEscalation.createdAt) {
      throw new EscalationLifecycleError(
        `Escalation resolution precedes creation: ${validatedEscalation.id}`,
      );
    }
    this.#assertAuditEventTime(
      transitionAt,
      validatedEvent,
      "escalation",
      validatedEscalation.id,
    );
    return { record: validatedEscalation, event: validatedEvent };
  }

  #insertEscalationAudit(
    escalation: { readonly record: EscalationRecord; readonly event: Event },
  ): void {
    this.#assertEscalationLedgerTransition(escalation.record);
    this.#insertEscalation(escalation.record);
    this.#appendValidatedEvent(escalation.event);
  }

  #insertEscalation(escalation: EscalationRecord): void {
    this.#database
      .prepare(`
        INSERT INTO escalations (
          id, mission_id, task_id, requester_id,
          decision_type, target_role, status, created_at, resolved_at, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        escalation.id,
        escalation.missionId,
        escalation.taskId ?? null,
        escalation.requesterId,
        escalation.decisionType,
        escalation.targetRole,
        escalation.status,
        escalation.createdAt.toISOString(),
        escalation.resolvedAt?.toISOString() ?? null,
        serialize(escalation),
      );
  }

  #assertEscalationLedgerTransition(escalation: EscalationRecord): void {
    const previous = this.getEscalation(escalation.id);
    if (escalation.status === "open") {
      if (previous !== undefined) {
        throw new EscalationLifecycleError(
          `Escalation already exists: ${escalation.id}`,
        );
      }
      return;
    }
    if (previous === undefined || previous.status !== "open") {
      throw new EscalationLifecycleError(
        `Escalation is not open: ${escalation.id}`,
      );
    }
    const immutableKeys = [
      "missionId",
      "taskId",
      "requesterId",
      "decisionType",
      "reason",
      "targetRole",
    ] as const;
    for (const key of immutableKeys) {
      if (previous[key] !== escalation[key]) {
        throw new EscalationLifecycleError(
          `Escalation identity changed while resolving ${escalation.id}: ${key}`,
        );
      }
    }
    if (previous.createdAt.getTime() !== escalation.createdAt.getTime()) {
      throw new EscalationLifecycleError(
        `Escalation creation timestamp changed while resolving: ${escalation.id}`,
      );
    }
    if (
      serialize(previous.requestedChange) !==
      serialize(escalation.requestedChange)
    ) {
      throw new EscalationLifecycleError(
        `Escalation requested change changed while resolving: ${escalation.id}`,
      );
    }
  }

  getEscalation(id: string): EscalationRecord | undefined {
    const escalation = rowData<EscalationRecord>(
      this.#database
        .prepare(`
          SELECT data FROM escalations
          WHERE id = ?
          ORDER BY entry_id DESC
          LIMIT 1
        `)
        .get(id),
    );
    return escalation === undefined
      ? undefined
      : EscalationRecordSchema.parse(escalation);
  }

  listEscalations(missionId?: string, taskId?: string): EscalationRecord[] {
    const missionFilter = missionId ?? null;
    const taskFilter = taskId ?? null;
    return allRowData<EscalationRecord>(
      this.#database
        .prepare(`
          SELECT data FROM escalations
          WHERE (? IS NULL OR mission_id = ?)
            AND (? IS NULL OR task_id = ?)
          ORDER BY created_at, entry_id
        `)
        .all(missionFilter, missionFilter, taskFilter, taskFilter),
    ).map((escalation) => EscalationRecordSchema.parse(escalation));
  }

  appendEvent(event: Event): void {
    event = EventSchema.parse(event);
    this.#appendValidatedEvent(event);
  }

  #appendValidatedEvent(event: Event): void {
    this.#database
      .prepare(`
        INSERT INTO events (id, mission_id, type, actor, created_at, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.missionId,
        event.type,
        event.actor ?? null,
        event.createdAt.toISOString(),
        serialize(event),
      );
  }

  #assertDoctrineEvent(
    missionId: string,
    event: Event,
    expectedType: string,
  ): void {
    if (event.missionId !== missionId || event.type !== expectedType) {
      throw new DoctrineAuditEventMismatchError(
        `Expected ${expectedType} event for mission ${missionId}, ` +
        `received ${event.type} for ${event.missionId}`,
      );
    }
  }

  #assertAuditEventTime(
    recordCreatedAt: Date,
    event: Event,
    recordType: string,
    recordId: string,
  ): void {
    if (event.createdAt < recordCreatedAt) {
      throw new DoctrineAuditEventMismatchError(
        `${recordType} event precedes record ${recordId}`,
      );
    }
  }

  #assertEventPayloadReference(
    event: Event,
    key: string,
    expected: string,
    auditType: string,
  ): void {
    if (
      typeof event.payload !== "object" ||
      event.payload === null ||
      Array.isArray(event.payload) ||
      event.payload[key] !== expected
    ) {
      throw new DoctrineAuditEventMismatchError(
        `${auditType} event does not reference ${key}=${expected}`,
      );
    }
  }

  listEvents(missionId?: string): Event[] {
    const rows = missionId === undefined
      ? this.#database.prepare("SELECT data FROM events ORDER BY created_at, rowid").all()
      : this.#database
          .prepare("SELECT data FROM events WHERE mission_id = ? ORDER BY created_at, rowid")
          .all(missionId);
    return allRowData<Event>(rows).map((event) => EventSchema.parse(event));
  }

  saveMissionAndEvent(mission: Mission, event: Event): void {
    this.#transaction(() => {
      this.saveMission(mission);
      this.appendEvent(event);
    });
  }

  saveTaskAndEvent(task: Task, event: Event): void {
    this.#transaction(() => {
      this.saveTask(task);
      this.appendEvent(event);
    });
  }

  saveReportAndEvent(report: Report, event: Event): void {
    this.#transaction(() => {
      this.saveReport(report);
      this.appendEvent(event);
    });
  }

  saveDecisionAndEvent(decision: Decision, event: Event): void {
    this.#transaction(() => {
      this.saveDecision(decision);
      this.appendEvent(event);
    });
  }

  transitionMission(
    missionId: string,
    nextStatus: MissionStatus,
    event: Event,
    permit?: RuntimeTransitionPermit,
  ): Mission {
    return this.#transaction(() => {
      const mission = this.getMission(missionId);
      if (mission === undefined) {
        throw new EntityNotFoundError("mission", missionId);
      }
      if (event.missionId !== missionId) {
        throw new TransitionEventMismatchError(
          `Event mission ${event.missionId} does not match mission ${missionId}`,
        );
      }

      assertMissionTransition(mission.status, nextStatus);
      consumeRuntimeTransitionPermit(permit, {
        entity: "mission",
        entityId: missionId,
        missionId,
        from: mission.status,
        to: nextStatus,
        eventId: event.id,
      });
      if (event.createdAt < mission.updatedAt) {
        throw new TransitionEventTimestampError("mission", missionId);
      }
      const updated: Mission = {
        ...mission,
        status: nextStatus,
        updatedAt: new Date(event.createdAt),
      };
      this.#upsertMission(MissionSchema.parse(updated));
      this.appendEvent(event);
      return updated;
    });
  }

  transitionTask(
    taskId: string,
    nextStatus: TaskStatus,
    event: Event,
    permit?: RuntimeTransitionPermit,
  ): Task {
    return this.#transaction(() => {
      const task = this.getTask(taskId);
      if (task === undefined) {
        throw new EntityNotFoundError("task", taskId);
      }
      if (event.missionId !== task.missionId) {
        throw new TransitionEventMismatchError(
          `Event mission ${event.missionId} does not match task mission ${task.missionId}`,
        );
      }

      assertTaskTransition(task.status, nextStatus);
      const claims = consumeRuntimeTransitionPermit(permit, {
        entity: "task",
        entityId: taskId,
        missionId: task.missionId,
        from: task.status,
        to: nextStatus,
        eventId: event.id,
      });
      if (task.status === "pending" && nextStatus === "running") {
        const worker = task.assignedAgentId === undefined
          ? undefined
          : this.getAgent(task.assignedAgentId);
        if (
          worker?.role !== "worker" ||
          claims.attempts !== task.attempts + 1
        ) {
          throw new ProtectedStateTransitionError(
            `Task ${taskId} start requires a registered Worker assignment and one incremented attempt`,
          );
        }
      } else if (claims.attempts !== undefined) {
        throw new ProtectedStateTransitionError(
          `Task ${taskId} assignment is only valid on pending -> running`,
        );
      }
      if (nextStatus === "completed") {
        if (claims.evidence === undefined) {
          throw new ProtectedStateTransitionError(
            `Task ${taskId} completion requires report and Evaluator PASS evidence`,
          );
        }
        const report = this.listReports(task.missionId, taskId)
          .find(({ id }) => id === claims.evidence!.reportId);
        const passed = this.listEvents(task.missionId).some((candidate) => {
          if (candidate.type !== "EvaluationPassed") return false;
          const payload = candidate.payload;
          const evaluator = candidate.actor === undefined
            ? undefined
            : this.getAgent(candidate.actor);
          return typeof payload === "object" && payload !== null &&
            !Array.isArray(payload) && payload.taskId === taskId &&
            payload.reportId === claims.evidence!.reportId && evaluator?.role === "evaluator";
        });
        if (report === undefined || !passed) {
          throw new ProtectedStateTransitionError(
            `Task ${taskId} completion evidence is not persisted`,
          );
        }
      }
      if (event.createdAt < task.updatedAt) {
        throw new TransitionEventTimestampError("task", taskId);
      }
      const updated: Task = {
        ...task,
        ...(claims.attempts === undefined ? {} : { attempts: claims.attempts }),
        status: nextStatus,
        updatedAt: new Date(event.createdAt),
      };
      this.#upsertTask(TaskSchema.parse(updated));
      this.appendEvent(event);
      return updated;
    });
  }

  loadMissionSnapshot(missionId: string): MissionSnapshot | undefined {
    const mission = this.getMission(missionId);
    if (mission === undefined) {
      return undefined;
    }

    return {
      mission,
      tasks: this.listTasks(missionId),
      reports: this.listReports(missionId),
      decisions: this.listDecisions(missionId),
      authorityGrants: this.listAuthorityGrants(missionId),
      constraints: this.listConstraints(missionId),
      riskLimits: this.listRiskLimits(missionId),
      authorizationRecords: this.listAuthorizationRecords(missionId),
      doctrineViolations: this.listDoctrineViolations(missionId),
      escalations: this.listEscalations(missionId),
      events: this.listEvents(missionId),
    };
  }

  loadSnapshot(): RuntimeSnapshot {
    return {
      missions: this.listMissions(),
      tasks: this.listTasks(),
      agents: this.listAgents(),
      reports: this.listReports(),
      decisions: this.listDecisions(),
      authorityGrants: this.listAuthorityGrants(),
      constraints: this.listConstraints(),
      riskLimits: this.listRiskLimits(),
      authorizationRecords: this.listAuthorizationRecords(),
      doctrineViolations: this.listDoctrineViolations(),
      escalations: this.listEscalations(),
      events: this.listEvents(),
    };
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #migrate(): void {
    const eventForeignKeys = this.#database
      .prepare("PRAGMA foreign_key_list(events)")
      .all();
    if (eventForeignKeys.length > 0) {
      this.#migrateEventsToCorrelationIds();
    }

    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN (
          'created', 'planning', 'executing', 'evaluating', 'replanning',
          'blocked', 'escalated', 'completed', 'failed', 'cancelled'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id),
        status TEXT NOT NULL CHECK(status IN (
          'pending', 'running', 'evaluating', 'blocked', 'completed',
          'failed', 'cancelled'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id),
        task_id TEXT REFERENCES tasks(id),
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS authority_grants (
        id TEXT PRIMARY KEY,
        issuer_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        mission_id TEXT NOT NULL REFERENCES missions(id),
        task_id TEXT REFERENCES tasks(id),
        permissions_json TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        risk_limits_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'revoked', 'expired')),
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        data TEXT NOT NULL,
        CHECK(
          (status = 'revoked' AND revoked_at IS NOT NULL)
          OR (status IN ('active', 'expired') AND revoked_at IS NULL)
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS constraints (
        grant_id TEXT NOT NULL REFERENCES authority_grants(id),
        position INTEGER NOT NULL CHECK(position >= 0),
        constraint_id TEXT NOT NULL,
        mission_id TEXT NOT NULL REFERENCES missions(id),
        subject_id TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (grant_id, position)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS risk_limits (
        grant_id TEXT NOT NULL REFERENCES authority_grants(id),
        position INTEGER NOT NULL CHECK(position >= 0),
        mission_id TEXT NOT NULL REFERENCES missions(id),
        subject_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        operator TEXT NOT NULL CHECK(operator IN ('lt', 'lte', 'eq')),
        value REAL NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (grant_id, position)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS authorization_results (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        task_id TEXT,
        actor_id TEXT NOT NULL,
        decision_type TEXT NOT NULL,
        result TEXT NOT NULL CHECK(result IN ('allow', 'deny', 'escalate')),
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS doctrine_violations (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        task_id TEXT,
        actor_id TEXT NOT NULL,
        decision_type TEXT NOT NULL,
        code TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS escalations (
        entry_id INTEGER PRIMARY KEY,
        id TEXT NOT NULL,
        mission_id TEXT NOT NULL REFERENCES missions(id),
        task_id TEXT REFERENCES tasks(id),
        requester_id TEXT NOT NULL,
        decision_type TEXT NOT NULL,
        target_role TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open', 'resolved')),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        data TEXT NOT NULL,
        UNIQUE(id, status),
        CHECK(
          (status = 'open' AND resolved_at IS NULL)
          OR (status = 'resolved' AND resolved_at IS NOT NULL)
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS tasks_by_mission
        ON tasks(mission_id, created_at, id);
      CREATE INDEX IF NOT EXISTS reports_by_mission
        ON reports(mission_id, created_at, id);
      CREATE INDEX IF NOT EXISTS reports_by_task
        ON reports(task_id, created_at, id);
      CREATE INDEX IF NOT EXISTS decisions_by_mission
        ON decisions(mission_id, created_at, id);
      CREATE INDEX IF NOT EXISTS authority_grants_by_mission_subject
        ON authority_grants(mission_id, subject_id, created_at, id);
      CREATE INDEX IF NOT EXISTS authority_grants_by_task
        ON authority_grants(task_id, created_at, id);
      CREATE INDEX IF NOT EXISTS constraints_by_mission_subject
        ON constraints(mission_id, subject_id, grant_id, position);
      CREATE INDEX IF NOT EXISTS risk_limits_by_mission_subject
        ON risk_limits(mission_id, subject_id, grant_id, position);
      CREATE INDEX IF NOT EXISTS authorization_results_by_mission
        ON authorization_results(mission_id, created_at, id);
      CREATE INDEX IF NOT EXISTS authorization_results_by_actor
        ON authorization_results(actor_id, created_at, id);
      CREATE INDEX IF NOT EXISTS doctrine_violations_by_mission
        ON doctrine_violations(mission_id, created_at, id);
      CREATE INDEX IF NOT EXISTS escalations_by_mission
        ON escalations(mission_id, created_at, entry_id);
      CREATE INDEX IF NOT EXISTS events_by_mission
        ON events(mission_id, created_at, id);

      CREATE TRIGGER IF NOT EXISTS authority_grants_keep_identity
      BEFORE UPDATE ON authority_grants
      WHEN OLD.id != NEW.id
        OR OLD.issuer_id != NEW.issuer_id
        OR OLD.subject_id != NEW.subject_id
        OR OLD.mission_id != NEW.mission_id
        OR OLD.task_id IS NOT NEW.task_id
        OR OLD.permissions_json != NEW.permissions_json
        OR OLD.constraints_json != NEW.constraints_json
        OR OLD.risk_limits_json != NEW.risk_limits_json
        OR OLD.created_at != NEW.created_at
        OR OLD.expires_at IS NOT NEW.expires_at
      BEGIN
        SELECT RAISE(ABORT, 'authority grant identity is immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS authority_grants_valid_lifecycle
      BEFORE UPDATE ON authority_grants
      WHEN OLD.status != 'active'
        OR NEW.status NOT IN ('revoked', 'expired')
      BEGIN
        SELECT RAISE(ABORT, 'invalid authority grant lifecycle transition');
      END;

      CREATE TRIGGER IF NOT EXISTS authority_grants_are_not_deleted
      BEFORE DELETE ON authority_grants
      BEGIN
        SELECT RAISE(ABORT, 'authority grants are retained for audit');
      END;

      CREATE TRIGGER IF NOT EXISTS constraints_are_append_only_on_update
      BEFORE UPDATE ON constraints
      BEGIN
        SELECT RAISE(ABORT, 'constraints are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS constraints_are_append_only_on_delete
      BEFORE DELETE ON constraints
      BEGIN
        SELECT RAISE(ABORT, 'constraints are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS risk_limits_are_append_only_on_update
      BEFORE UPDATE ON risk_limits
      BEGIN
        SELECT RAISE(ABORT, 'risk limits are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS risk_limits_are_append_only_on_delete
      BEFORE DELETE ON risk_limits
      BEGIN
        SELECT RAISE(ABORT, 'risk limits are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS authorization_results_are_append_only_on_update
      BEFORE UPDATE ON authorization_results
      BEGIN
        SELECT RAISE(ABORT, 'authorization results are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS authorization_results_are_append_only_on_delete
      BEFORE DELETE ON authorization_results
      BEGIN
        SELECT RAISE(ABORT, 'authorization results are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS doctrine_violations_are_append_only_on_update
      BEFORE UPDATE ON doctrine_violations
      BEGIN
        SELECT RAISE(ABORT, 'doctrine violations are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS doctrine_violations_are_append_only_on_delete
      BEFORE DELETE ON doctrine_violations
      BEGIN
        SELECT RAISE(ABORT, 'doctrine violations are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS escalations_are_append_only_on_update
      BEFORE UPDATE ON escalations
      BEGIN
        SELECT RAISE(ABORT, 'escalations are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS escalations_are_append_only_on_delete
      BEFORE DELETE ON escalations
      BEGIN
        SELECT RAISE(ABORT, 'escalations are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS events_are_append_only_on_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS events_are_append_only_on_delete
      BEFORE DELETE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;

      PRAGMA user_version = 2;
    `);
  }

  #migrateEventsToCorrelationIds(): void {
    this.#database.exec("PRAGMA foreign_keys = OFF");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(`
        DROP TRIGGER IF EXISTS events_are_append_only_on_update;
        DROP TRIGGER IF EXISTS events_are_append_only_on_delete;
        DROP INDEX IF EXISTS events_by_mission;

        ALTER TABLE events RENAME TO events_v1;

        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL,
          type TEXT NOT NULL,
          actor TEXT,
          created_at TEXT NOT NULL,
          data TEXT NOT NULL
        ) STRICT;

        INSERT INTO events (id, mission_id, type, actor, created_at, data)
        SELECT id, mission_id, type, actor, created_at, data
        FROM events_v1
        ORDER BY rowid;

        DROP TABLE events_v1;
      `);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON");
    }
  }
}
