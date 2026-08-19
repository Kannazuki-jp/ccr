import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AgentRecordSchema,
  DecisionSchema,
  EventSchema,
  MissionSchema,
  ReportSchema,
  TaskSchema,
  type AgentRecord,
  type Decision,
  type Event,
  type Mission,
  type MissionStatus,
  type Report,
  type Task,
  type TaskStatus,
} from "../../domain/index.js";
import { assertMissionTransition, assertTaskTransition } from "../../runtime/state-machine.js";

type JsonRow = { readonly data: string };

const DATE_KEYS = new Set(["createdAt", "updatedAt"]);

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

export type MissionSnapshot = {
  mission: Mission;
  tasks: Task[];
  reports: Report[];
  decisions: Decision[];
  events: Event[];
};

export type RuntimeSnapshot = {
  missions: Mission[];
  tasks: Task[];
  agents: AgentRecord[];
  reports: Report[];
  decisions: Decision[];
  events: Event[];
};

/**
 * Synchronous SQLite persistence for the prototype runtime.
 *
 * Each row keeps the identifiers needed for queries alongside a canonical JSON
 * snapshot. Runtime transitions use an explicit transaction so the updated
 * aggregate and its event are either both visible or both rolled back.
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
    if (existing !== undefined && existing.status !== validated.status) {
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
    if (existing !== undefined && existing.status !== validated.status) {
      throw new DirectStateMutationError(
        "task",
        validated.id,
        existing.status,
        validated.status,
      );
    }
    this.#upsertTask(validated);
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

  appendEvent(event: Event): void {
    event = EventSchema.parse(event);
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

  transitionMission(missionId: string, nextStatus: MissionStatus, event: Event): Mission {
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

  transitionTask(taskId: string, nextStatus: TaskStatus, event: Event): Task {
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
      if (event.createdAt < task.updatedAt) {
        throw new TransitionEventTimestampError("task", taskId);
      }
      const updated: Task = {
        ...task,
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

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id),
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
      CREATE INDEX IF NOT EXISTS events_by_mission
        ON events(mission_id, created_at, id);

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

      PRAGMA user_version = 1;
    `);
  }
}
