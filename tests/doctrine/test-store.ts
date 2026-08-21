import type {
  AgentRecord,
  AuthorityGrant,
  AuthorizationRecord,
  DoctrineViolationRecord,
  EscalationRecord,
  Event,
  Mission,
  Report,
  Task,
} from "../../src/domain/index.js";
import type {
  AuthorityGrantAudit,
  AuthorityRevocationAudit,
  DoctrineDenialAudit,
  DoctrineStore,
  EscalationAudit,
} from "../../src/runtime/doctrine/index.js";

export const MISSION_ID = "00000000-0000-4000-8000-000000000001";
export const TASK_ID = "00000000-0000-4000-8000-000000000002";

export class TestDoctrineStore implements DoctrineStore {
  readonly agents: AgentRecord[] = [];
  readonly grants: AuthorityGrant[] = [];
  readonly missions: Mission[] = [];
  readonly tasks: Task[] = [];
  readonly reports: Report[] = [];
  readonly authorizations: AuthorizationRecord[] = [];
  readonly violations: DoctrineViolationRecord[] = [];
  readonly escalations: EscalationRecord[] = [];
  readonly events: Event[] = [];

  constructor() {
    const createdAt = new Date("2026-08-20T00:00:00.000Z");
    for (const role of ["commander", "lead", "worker", "evaluator"] as const) {
      this.agents.push({
        id: `${role}-01`,
        name: role,
        role,
        implementation: "mock",
        createdAt,
        updatedAt: createdAt,
      });
    }
    this.missions.push({
      id: MISSION_ID,
      goal: "Test doctrine boundaries",
      intent: {
        purpose: "Exercise deterministic enforcement",
        endState: ["Doctrine invariants hold"],
        priorities: ["Safety"],
        constraints: [],
      },
      successCriteria: ["All checks pass"],
      status: "executing",
      createdAt,
      updatedAt: createdAt,
    });
    this.tasks.push({
      id: TASK_ID,
      missionId: MISSION_ID,
      objective: "Exercise a bounded task",
      successCriteria: ["The bounded action succeeds"],
      constraints: [],
      authority: { allowed: [], prohibited: [], requiresApproval: [] },
      assignedAgentId: "worker-01",
      dependencies: [],
      status: "running",
      attempts: 1,
      createdAt,
      updatedAt: createdAt,
    });
    this.events.push(
      {
        id: "mission-created-binding",
        missionId: MISSION_ID,
        type: "MissionCreated",
        actor: "commander-01",
        payload: {},
        createdAt,
      },
      {
        id: "lead-authority-binding",
        missionId: MISSION_ID,
        type: "AuthorityGranted",
        actor: "commander-01",
        payload: { subjectId: "lead-01" },
        createdAt,
      },
    );
  }

  getAgent(id: string): AgentRecord | undefined {
    return this.agents.find((agent) => agent.id === id);
  }

  getMission(id: string): Mission | undefined {
    return this.missions.find((mission) => mission.id === id);
  }

  getTask(id: string): Task | undefined {
    return this.tasks.find((task) => task.id === id);
  }

  listTasks(missionId?: string): Task[] {
    return this.tasks.filter(
      (task) => missionId === undefined || task.missionId === missionId,
    );
  }

  getEscalation(id: string): EscalationRecord | undefined {
    return this.escalations.findLast((escalation) => escalation.id === id);
  }

  listReports(missionId?: string, taskId?: string): Report[] {
    return this.reports.filter(
      (report) =>
        (missionId === undefined || report.missionId === missionId) &&
        (taskId === undefined || report.taskId === taskId),
    );
  }

  listEvents(missionId?: string): Event[] {
    return this.events.filter(
      (event) => missionId === undefined || event.missionId === missionId,
    );
  }

  getAuthorityGrant(id: string): AuthorityGrant | undefined {
    return this.grants.find((grant) => grant.id === id);
  }

  listAuthorityGrants(
    missionId: string,
    subjectId?: string,
  ): AuthorityGrant[] {
    return this.grants.filter(
      (grant) =>
        grant.missionId === missionId &&
        (subjectId === undefined || grant.subjectId === subjectId),
    );
  }

  grantAuthority(grant: AuthorityGrant, event: Event): void {
    this.grants.push(structuredClone(grant));
    this.events.push(structuredClone(event));
  }

  grantAuthorityWithAudit(input: AuthorityGrantAudit): void {
    this.grants.push(structuredClone(input.grant));
    this.events.push(
      structuredClone(input.grantEvent),
      ...input.constraintEvents.map((event) => structuredClone(event)),
      structuredClone(input.authorization.event),
    );
    this.authorizations.push(structuredClone(input.authorization.record));
  }

  revokeAuthorityGrant(
    grantId: string,
    revokedAt: Date,
    event: Event,
  ): AuthorityGrant {
    const index = this.grants.findIndex(({ id }) => id === grantId);
    const grant = this.grants[index];
    if (grant === undefined || grant.status !== "active") {
      throw new Error(`active grant not found: ${grantId}`);
    }
    const revoked: AuthorityGrant = {
      ...grant,
      status: "revoked",
      revokedAt,
    };
    this.grants[index] = revoked;
    this.events.push(structuredClone(event));
    return structuredClone(revoked);
  }

  revokeAuthorityGrantWithAudit(
    input: AuthorityRevocationAudit,
  ): AuthorityGrant {
    const revoked = this.revokeAuthorityGrant(
      input.grantId,
      input.revokedAt,
      input.revokeEvent,
    );
    this.authorizations.push(structuredClone(input.authorization.record));
    this.events.push(structuredClone(input.authorization.event));
    return revoked;
  }

  expireAuthorityGrant(grantId: string, event: Event): AuthorityGrant {
    const index = this.grants.findIndex(({ id }) => id === grantId);
    const grant = this.grants[index];
    if (grant === undefined || grant.status !== "active") {
      throw new Error(`active grant not found: ${grantId}`);
    }
    const expired: AuthorityGrant = { ...grant, status: "expired" };
    this.grants[index] = expired;
    this.events.push(structuredClone(event));
    return structuredClone(expired);
  }

  saveEscalationAndEvent(
    escalation: EscalationRecord,
    event: Event,
  ): void {
    this.escalations.push(structuredClone(escalation));
    this.events.push(structuredClone(event));
  }

  saveEscalationWithAudit(input: EscalationAudit): void {
    this.escalations.push(structuredClone(input.escalation));
    this.events.push(
      structuredClone(input.escalationEvent),
      structuredClone(input.authorization.event),
    );
    this.authorizations.push(structuredClone(input.authorization.record));
  }

  saveAuthorizationRecordAndEvent(
    record: AuthorizationRecord,
    event: Event,
  ): void {
    if (event.createdAt < record.createdAt) {
      throw new Error("authorization event precedes its record");
    }
    this.authorizations.push(structuredClone(record));
    this.events.push(structuredClone(event));
  }

  saveDoctrineViolationAndEvent(
    violation: DoctrineViolationRecord,
    event: Event,
  ): void {
    this.violations.push(structuredClone(violation));
    this.events.push(structuredClone(event));
  }

  saveDoctrineDenialAudit(input: DoctrineDenialAudit): void {
    this.violations.push(structuredClone(input.violation));
    this.events.push(
      structuredClone(input.violationEvent),
      ...input.relatedEvents.map((event) => structuredClone(event)),
      structuredClone(input.authorization.event),
    );
    this.authorizations.push(structuredClone(input.authorization.record));
  }

  appendEvent(event: Event): void {
    this.events.push(structuredClone(event));
  }
}
