# Prototype v0.1 acceptance and automated evidence matrix

This document is the requirement-to-evidence design and completion record for the
implementation brief. Matrix IDs describe behaviors; they are not required to be
one-test-per-ID names. The authoritative automated gate is `pnpm run check`, and
the completion snapshot below maps the Brief's 19 criteria to concrete tests.

## Priority and evidence rules

- **P0**: required by an acceptance criterion, an explicit implementation
  principle, or a necessary invariant of the described C2 loop. Every Brief-level
  P0 behavior must be covered by the passing gate before Prototype v0.1 is complete.
- **P1**: recovery, ergonomics, or defensive hardening beyond the brief's minimum
  completion definition. P1 failures must be reported but do not by themselves
  contradict completion of the brief.
- Unit evidence proves one contract or state transition. Integration evidence uses
  the real runtime and SQLite storage with deterministic agents. The CLI test calls
  the exported production entrypoint in-process because the sandbox denies nested
  process spawning; a separate built-CLI shell smoke is part of the final audit.
- A test is evidence only when it asserts persisted state and/or an observable
  return value. Merely asserting that a function was called is insufficient for a
  state-management requirement.
- Agent prose, a mock's private state, and console text alone are never evidence of
  a Mission or Task state transition. Runtime return values and SQLite rows are.

## Completion evidence snapshot — 2026-08-19

`corepack pnpm run check` passes strict typecheck, all 30 test cases in five test
files, and the production build. The built entrypoint was also executed with:

```bash
node dist/cli/main.js run mission "Built CLI validation" --db /tmp/cc-runtime-built.sqlite --json
```

It returned `completed` with `MissionCompleted` as the recent durable event.

| Brief §21 criterion | Status | Primary evidence |
| --- | --- | --- |
| Goal input | PASS | `cli.test.ts`, `runtime.test.ts` |
| Goal → Mission | PASS | happy-path integration + SQLite snapshot |
| Commander's Intent | PASS | domain schemas + persisted happy Mission |
| Mission Success Criteria | PASS | domain schemas + persisted happy Mission |
| Mission → Tasks | PASS | three-task dependency integration |
| Worker assignment | PASS | `TaskAssigned` events + persisted agent IDs |
| Task Result | PASS | Worker integration calls + report output |
| Structured Report | PASS | report rows before evaluation |
| Evaluator PASS / FAIL | PASS | happy, retry, replan, escalation, fail scenarios |
| PASS → Task completed | PASS | event order + state-machine tests |
| FAIL → retry / replan | PASS | retry history and replacement-plan tests |
| Out-of-authority escalation | PASS | Worker and Evaluator escalation tests |
| Mission / Task SQLite state | PASS | store + restart tests |
| Decision persistence | PASS | retry/replan/escalate/fail snapshots |
| Event history | PASS | ordered integration events + append-only triggers |
| Restart read | PASS | fresh store/runtime observation with zero Agent calls |
| Mock / LLM exchange | PASS | four LLM adapters over fake structured provider |
| Mission completed | PASS | happy, retry, replan, CLI tests |
| Full C2 integration | PASS | `runtime.test.ts` happy three-task loop |

The detailed matrix below also records defensive and future-hardening scenarios.
Its P0/P1 labels are risk priorities for that verification backlog; they do not
expand the Implementation Brief's completion definition. A detailed ID is current
evidence only when it is exercised by the test files named in the completion
snapshot. For example, automatic crash resume, every possible foreign-key policy,
and CLI exit-code conventions are useful follow-up work but are not Brief §21
acceptance requirements.

## Canonical observable event ordering

Event type names may use a consistently documented equivalent, but the following
semantic partial orders are P0. Payloads must identify the Mission, identify the
Task when applicable, name the actor, and contain the reason or recommendation for
decision events.

### Happy path

```text
MissionCreated
  < MissionPlanned
  < TaskCreated
  < TaskAssigned
  < TaskStarted
  < EvaluationPassed
  < TaskCompleted
  < MissionCompleted
```

For multiple Tasks, every dependency's `TaskCompleted` precedes the dependent's
`TaskStarted`, and all `TaskCompleted` events precede `MissionCompleted`. Report
storage must occur before evaluation; it may be represented by a `ReportSubmitted`
event in addition to the required `reports` row.

### Retry, replan, escalation, and terminal failure

```text
retry:
TaskStarted < EvaluationFailed < DecisionMade(retry)
            < TaskStarted < EvaluationPassed < TaskCompleted

replan:
EvaluationFailed < DecisionMade(replan) < MissionReplanned
                 < replacement TaskCreated < replacement TaskStarted

escalate:
TaskBlocked/EvaluationFailed < DecisionMade(escalate)
                             < EscalationRequested

terminal failure:
EvaluationFailed < DecisionMade(fail) < TaskFailed < MissionFailed
```

No failure branch may append `TaskCompleted` or `MissionCompleted` before a later
validated PASS.

## Requirement-to-evidence traceability

| Brief acceptance requirement | Priority | Primary automated evidence |
| --- | --- | --- |
| Goal can be supplied | P0 | `HP-01`, `CLI-01`, `VAL-01` |
| Goal produces a Mission | P0 | `HP-01`, `SCHEMA-01`, `DB-02` |
| Commander's Intent is represented | P0 | `SCHEMA-01`, `CTX-01`, `DB-02` |
| Mission has Success Criteria | P0 | `SCHEMA-01`, `DB-02`, `CTX-04` |
| Mission decomposes into Tasks | P0 | `HP-01`, `HP-02`, `PLAN-01` |
| Task is assigned to Worker | P0 | `HP-01`, `CTX-03`, `LOG-01` |
| Worker returns a Task Result | P0 | `SCHEMA-03`, `HP-01` |
| Worker returns a Structured Report | P0 | `SCHEMA-03`, `DB-04`, `CTX-04` |
| Evaluator decides PASS / FAIL | P0 | `SCHEMA-04`, `HP-01`, `FAIL-01` through `FAIL-04` |
| PASS transitions Task to completed | P0 | `TASK-SM-01`, `OWN-03`, `HP-01` |
| FAIL can retry / replan | P0 | `FAIL-01`, `FAIL-02`, `TASK-SM-02`, `MISSION-SM-02` |
| Out-of-authority decision escalates | P0 | `AUTH-02`, `AUTH-03`, `FAIL-03`, `CLI-03` |
| Mission / Task state persists in SQLite | P0 | `DB-01`, `DB-02`, `DB-03` |
| Decision persists | P0 | `DB-05`, `LOG-02` through `LOG-04` |
| Event history persists | P0 | `DB-06`, `LOG-01` through `LOG-04` |
| State is readable after restart | P0 | `RESTART-01` |
| Mock / LLM implementations swap through interfaces | P0 | `AGENT-01`, `AGENT-02`, `SCHEMA-06` |
| Mission reaches completed | P0 | `HP-01`, `HP-02`, `CLI-01` |
| Integration test covers the full C2 loop | P0 | `HP-01`, `USECASE-01` |

Additional explicit requirements are traced as follows.

| Explicit principle or deliverable | Priority | Automated evidence |
| --- | --- | --- |
| Runtime alone owns state and transitions | P0 | `OWN-01` through `OWN-05` |
| Invalid state transitions are rejected | P0 | `MISSION-SM-03`, `TASK-SM-03`, `TASK-SM-04` |
| Every agent output is schema-validated before use | P0 | `SCHEMA-01` through `SCHEMA-07` |
| Failure, blocked, escalation, and replan remain visible | P0 | `FAIL-01` through `FAIL-05`, `LOG-02` through `LOG-04` |
| Agent receives only role-relevant context | P0 | `CTX-01` through `CTX-05` |
| SQLite has missions/tasks/agents/reports/decisions/events | P0 | `DB-01` |
| Doctrine content is not invented | P0 | `SCOPE-02` |
| One Worker, no parallel execution | P0 | `PLAN-03`, `SCOPE-01` |
| Minimal CLI shows six required fields | P0 | `CLI-01`, `CLI-03` |

## Detailed verification matrix and hardening backlog

### Domain and structured-output validation

| ID | Pri | Level | Scenario | Expected observable evidence |
| --- | --- | --- | --- | --- |
| `VAL-01` | P0 | unit | Empty or whitespace-only Goal | Public run command rejects before Commander invocation; no Mission or event row is written. |
| `SCHEMA-01` | P0 | unit | Valid Commander proposal | Proposal accepts purpose, non-empty end state, priorities, constraints, and success criteria; Runtime supplies ID, timestamps, and initial status. |
| `SCHEMA-02` | P0 | unit | Invalid Commander proposal | Missing intent member, wrong type, empty required collection, or invalid JSON is rejected; no Mission proceeds to planning. |
| `SCHEMA-03` | P0 | unit | Valid Lead and Worker outputs | Task proposals and Worker result/report accept only documented fields and enum values; nested escalation and authority data round-trip. |
| `SCHEMA-04` | P0 | unit | Every Evaluator outcome | `pass/complete` and `fail/retry|replan|escalate|fail` validate and preserve all reasons. |
| `SCHEMA-05` | P0 | unit | Invalid enum or incompatible evaluation | Unknown result/recommendation is rejected. `pass` with a non-`complete` recommendation and `fail` with `complete` are rejected either by schema refinement or Runtime semantic validation. |
| `SCHEMA-06` | P0 | integration | Bad output from an injected agent | Malformed JSON, missing required property, wrong type, and extra control fields surface as a typed validation failure; no unvalidated domain object or completion transition is persisted. A failure event identifies role and schema, without secrets/raw prompts. |
| `SCHEMA-07` | P0 | integration | Validation applies to Mock as well as LLM adapter | An intentionally invalid Mock output is rejected through the same Runtime boundary, proving validation is implementation-independent. |
| `SCHEMA-08` | P0 | unit | Domain persistence serialization | Dates serialize to a stable SQLite representation and hydrate as valid dates; arrays/objects round-trip without loss. |
| `SCHEMA-09` | P1 | unit | Oversized or deeply nested structured output | Boundary rejects configured excessive input cleanly without partial state changes. |

### Runtime-only state ownership

| ID | Pri | Level | Scenario | Expected observable evidence |
| --- | --- | --- | --- | --- |
| `OWN-01` | P0 | integration | Commander output attempts `status: completed`, custom ID, or timestamps | Strict validation rejects the control fields, or Runtime discards them; persisted Mission ID/status/timestamps are Runtime-generated and Mission is not completed. |
| `OWN-02` | P0 | integration | Lead Task proposal attempts to assign a terminal status | Proposal cannot force status; persisted Task starts `pending` and its assignment is performed by Runtime. |
| `OWN-03` | P0 | integration | Worker says "completed" / returns success | Task remains non-completed until a valid Evaluator PASS is validated and Runtime performs the transition. |
| `OWN-04` | P0 | unit | Agent mutates its input object | Mutation of a copy/read-only input cannot mutate the stored Mission, Task, authority, or criteria. |
| `OWN-05` | P0 | integration | Agent returns another Mission/Task ID | Runtime rejects the mismatch or binds results to the invoked entity; no other row changes. |

### Mission state machine

The implementation should document one explicit transition table. To support the
brief's multi-Task example, `evaluating -> executing` is valid only after PASS when
more Tasks remain. `evaluating -> replanning -> executing` is the FAIL/replan path.

| ID | Pri | Level | Scenario | Expected observable evidence |
| --- | --- | --- | --- | --- |
| `MISSION-SM-01` | P0 | unit | Happy transitions | `created -> planning -> executing -> evaluating -> completed` succeeds. If more Tasks remain, `evaluating -> executing` succeeds only under Runtime's "more work" guard. |
| `MISSION-SM-02` | P0 | unit | Replan transitions | `evaluating -> replanning -> executing` succeeds and timestamps advance monotonically. |
| `MISSION-SM-03` | P0 | unit/table | Every unlisted transition | State machine rejects every edge not in its explicit transition table, including skipping directly from created/planning to completed. Persisted state and events stay unchanged. |
| `MISSION-SM-04` | P0 | unit/table | Terminal states | `completed`, `failed`, and `cancelled` have no outgoing transition. Re-running completion is handled as a no-op by an idempotent orchestration command, not as a state-machine edge. |
| `MISSION-SM-05` | P0 | unit | Exceptional states | Defined entries into blocked, escalated, failed, and cancelled succeed only from documented non-terminal states and record the cause. |

### Task state machine

| ID | Pri | Level | Scenario | Expected observable evidence |
| --- | --- | --- | --- | --- |
| `TASK-SM-01` | P0 | unit | PASS path | `pending -> running -> evaluating -> completed` succeeds; timestamps advance. |
| `TASK-SM-02` | P0 | unit | Retry path | Evaluator `fail/retry` returns the same Task to an executable non-terminal state (recommended `evaluating -> pending`) without ever representing it as completed. |
| `TASK-SM-03` | P0 | unit/table | Illegal edges | At minimum `completed -> running`, `pending -> completed`, and `running -> completed` without evaluation are rejected; all unspecified edges are rejected. |
| `TASK-SM-04` | P0 | unit | Atomic rejection | An illegal Task transition changes neither Task status/timestamp nor Event history. |
| `TASK-SM-05` | P0 | unit | Blocked / failure / cancellation | Runtime can enter the explicit non-success states and includes a cause; terminal Task states have no outgoing state-machine edges. |

### Agent interfaces and context routing

| ID | Pri | Level | Scenario | Expected observable evidence |
| --- | --- | --- | --- | --- |
| `AGENT-01` | P0 | type/unit | Role interface contracts | Commander, Lead, Worker, and Evaluator Mocks satisfy their role interfaces without Runtime importing a concrete class. |
| `AGENT-02` | P0 | integration | Swap implementation | Replacing a Mock with a fake LLM adapter through constructor/config injection runs the same Runtime path and validation boundary; no Runtime source change is needed. No live network call is required. |
| `CTX-01` | P0 | unit/spy | Commander call | Receives Goal only; does not receive SQLite handle, other agent outputs, or mutable Runtime state. |
| `CTX-02` | P0 | unit/spy | Lead plan/replan calls | `plan` receives Mission/Intent/current state. `replan` also receives the failed result/evaluation context, but not unrelated raw logs. |
| `CTX-03` | P0 | unit/spy | Worker call | Receives exactly Task, relevant dependency context, authority, and constraints; assigned agent ID matches persisted Task assignment. |
| `CTX-04` | P0 | unit/spy | Evaluator call | Receives Task, Task Result, and applicable Success Criteria; stored report precedes the call. |
| `CTX-05` | P0 | unit/spy | Context minimization | Unrelated Tasks, decisions, events, raw provider prompts/responses, and storage internals are absent from lower-role input. |

### Planning, dependencies, and happy-path integration

| ID | Pri | Level | Scenario | Expected observable evidence |
| --- | --- | --- | --- | --- |
| `PLAN-01` | P0 | unit | Valid decomposition | Lead proposals create durable Tasks with objective, criteria, constraints, dependencies, Mission ID, and Runtime-generated IDs. |
| `PLAN-02` | P0 | unit | Invalid dependency graph | Unknown dependency, self-dependency, duplicate ID/key, or cycle is rejected before Worker execution; no partial Task set runs. |
| `PLAN-03` | P0 | integration | Sequential scheduling | Runnable Tasks execute only after dependencies complete and maximum simultaneous Worker invocations is exactly one. |
| `HP-01` | P0 | integration/SQLite | Brief's first milestone | `runtime.run({ goal: "Add completed todo endpoint" })` with happy Mocks returns `status: completed`; one Mission, at least one completed Task, report(s), and ordered events are durable. Commander/Lead run once; Worker/Evaluator run once per Task. |
| `HP-02` | P0 | integration/SQLite | Three dependent Tasks | Research, implementation, and tests execute in dependency order. Mission is not completed after the first/second PASS and completes only after all three durable Task rows are completed. |
| `HP-03` | P0 | integration | Report routing | Each Worker result creates a Structured Report row tied to Task and agent before Evaluator is invoked; summary/problems/risks/decisionRequired/escalation round-trip. |
| `HP-04` | P0 | integration | Agent invocation exception | Rejection/throw becomes an explicit failed or blocked outcome plus diagnostic event; Runtime does not hang or claim completion. |

### Evaluator FAIL, retry, replan, escalation, and terminal failure

| ID | Pri | Level | Scenario | Expected observable evidence |
| --- | --- | --- | --- | --- |
| `FAIL-01` | P0 | integration/SQLite | Retry then PASS | Configured Evaluator returns `fail/retry` once, then PASS. Same logical Task is executed/evaluated twice, both reports remain durable, retry Decision is stored, no replan call occurs, and Mission ultimately completes. |
| `FAIL-02` | P0 | integration/SQLite | Replan then PASS | First evaluation returns `fail/replan`; Mission enters replanning, `Lead.replan` receives reasons/context, failed work is resolved explicitly, replacement Task(s) persist and run, and Mission completes only after their PASS. |
| `FAIL-03` | P0 | integration/SQLite | Evaluator requests escalation | `fail/escalate` stores Decision and EscalationRequested event, moves Mission to escalated and current Task to a non-completed state, stops scheduling, and never calls `Lead.replan`. |
| `FAIL-04` | P0 | integration/SQLite | Unrecoverable FAIL | `fail/fail` stores reasons, marks Task/Mission failed, stops scheduling, and appends TaskFailed/MissionFailed without any completion event. |
| `FAIL-05` | P0 | integration/SQLite | Worker reports blocked + escalation required | Runtime does not treat report as success; Task is blocked, Mission is escalated, reason is visible and durable, and Evaluator is skipped unless the implementation explicitly documents evaluation of blocked reports. |
| `FAIL-06` | P0 | integration | Replan output invalid | Invalid replacement plan fails visibly and atomically; old failure history is retained, no invalid Task executes, and Mission cannot become completed. |
| `FAIL-07` | P1 | integration | Endless retry protection | Configured retry limit prevents an infinite loop, stores a terminal Decision, and exits predictably. The brief does not prescribe a retry count. |

### Authority and escalation

| ID | Pri | Level | Scenario | Expected observable evidence |
| --- | --- | --- | --- | --- |
| `AUTH-01` | P0 | unit | Authority model | `allowed`, `prohibited`, and `requiresApproval` are distinct and schema-validated; they are supplied to Worker context. |
| `AUTH-02` | P0 | integration | Prohibited operation | Worker requests an operation listed as prohibited; no operation is performed, report/decision explains denial, and Mission escalates or blocks according to documented policy. |
| `AUTH-03` | P0 | integration | Approval-required operation | Runtime pauses before execution, stores escalation to Commander/Human with action/reason, and exposes escalated status. |
| `AUTH-04` | P0 | integration | Allowed operation | Allowed request proceeds without escalation; the allowed list does not silently authorize prohibited or approval-required actions. |
| `AUTH-05` | P0 | integration | Escalation boundary | Escalation changes neither Mission purpose, Commander's Intent, nor constraints; changes to those remain Commander/Human decisions. |

### SQLite persistence, decisions, and events

| ID | Pri | Level | Scenario | Expected observable evidence |
| --- | --- | --- | --- | --- |
| `DB-01` | P0 | integration/SQLite metadata | Storage initialization | SQLite contains at least `missions`, `tasks`, `agents`, `reports`, `decisions`, and `events`; foreign keys are enabled. |
| `DB-02` | P0 | integration/SQLite | Mission and Task fields | All brief domain fields survive create/read including intent, criteria, constraints, dependencies, assignment, statuses, and timestamps. |
| `DB-03` | P0 | integration/SQLite | State transition durability | Every committed Runtime transition is visible from a fresh storage instance; no state exists only in process memory. |
| `DB-04` | P0 | integration/SQLite | Report history | Report fields and agent/task references persist; retry creates history rather than overwriting the previous report. |
| `DB-05` | P0 | integration/SQLite | Decision history | retry/replan/escalate/fail Decisions retain actor, recommendation/action, reason, Mission/Task reference, and timestamp. |
| `DB-06` | P0 | integration/SQLite | Event append-only history | Events have unique ID, Mission ID, type, actor, payload, createdAt; later transitions append and never rewrite earlier events. |
| `DB-07` | P0 | integration | Transaction failure | Forced storage failure during a transition rolls back state, associated decision/report as applicable, and event together; reload shows no half-transition. |
| `DB-08` | P0 | integration | Referential integrity | Orphan Task/report/decision/event insert is rejected or impossible through API; cascade policy does not erase append-only history accidentally. |
| `DB-09` | P1 | integration | Migration idempotency | Opening an initialized DB repeatedly is harmless and retains data. |
| `DB-10` | P0 | integration | Agent registry / assignment | Persisted agent records distinguish four roles/implementations and Task assignment refers to the Worker record. |

### Decision and event log scenarios

| ID | Pri | Level | Scenario | Expected observable evidence |
| --- | --- | --- | --- | --- |
| `LOG-01` | P0 | integration | Happy event order | The happy-path semantic order above holds, and `EvaluationPassed` precedes Runtime-owned `TaskCompleted`. |
| `LOG-02` | P0 | integration | Retry log | Evaluation failure reasons and retry Decision precede the second attempt; no MissionReplanned event exists. |
| `LOG-03` | P0 | integration | Replan log | Failed evaluation, replan Decision, MissionReplanned, and replacement Task creation are all present in order. |
| `LOG-04` | P0 | integration | Escalation/failure log | Cause and actor appear in Decision/Event payloads, while completion events are absent. |
| `LOG-05` | P1 | integration | Timestamp tie | Stable insertion sequence/ID provides deterministic recent-event order even when timestamps are identical. |

### Restart, recovery, and idempotency

The brief explicitly requires state **readability** after restart, not automatic
continuation or exactly-once Worker side effects. `RESTART-01` is therefore P0;
automatic recovery rows are P1 unless the public runtime advertises `resume`.

| ID | Pri | Level | Scenario | Expected observable evidence |
| --- | --- | --- | --- | --- |
| `RESTART-01` | P0 | integration/new process or new connection | Reopen SQLite | Fresh Runtime/storage instance reads the same Mission/Task statuses, intent, reports, Decisions, and ordered Events without calling any agent. |
| `IDEMP-01` | P0 | integration | Observe completed Mission again | Read/status operation is side-effect free; agent call counts and event/report/decision row counts do not change. |
| `IDEMP-02` | P0 | unit/integration | Duplicate transition request | Repeated orchestration command either returns current state as no-op or a typed invalid-transition result; it never duplicates terminal events or regresses state. |
| `IDEMP-03` | P0 | integration | Agent output validation failure | Retrying after fixing the agent starts from the last durable valid state; invalid attempt left no fabricated completed state. |
| `RECOVERY-01` | P1 | integration/reopen | Crash after report, before evaluation | Resume reuses durable report rather than rerunning Worker, then evaluates exactly once and records a recovery event. |
| `RECOVERY-02` | P1 | integration/reopen | Crash while Task running, before report | Runtime follows a documented at-least-once policy: returns Task to runnable state or blocks for human review. It never silently marks success. Potential external side-effect duplication is disclosed. |
| `RECOVERY-03` | P1 | integration/reopen | Resume completed Mission | Returns completed immediately with no agent calls and no duplicate MissionCompleted event. |

### CLI and explicit integration use case

| ID | Pri | Level | Scenario | Expected observable evidence |
| --- | --- | --- | --- | --- |
| `CLI-01` | P0 | CLI/process | `run mission "Add completed todo endpoint"` | Exit is successful; output includes Mission, Status=`completed`, Current Task (or explicit none), Recent Event, Escalation (none), and Final Result. SQLite independently proves completion. |
| `CLI-02` | P0 | CLI/process | Missing/empty Goal | Non-zero exit, concise usage/validation message, no Mission row. |
| `CLI-03` | P0 | CLI/process | Escalation scenario | Output visibly contains Mission, `escalated` Status, blocked/current Task, recent EscalationRequested event, escalation reason/target, and non-success Final Result; SQLite agrees. |
| `CLI-04` | P0 | CLI/process | Terminal failure scenario | Non-success exit/result, reasons are visible, no completion claim, and persisted Mission is failed. |
| `USECASE-01` | P0 | integration | Brief's TODO example | Deterministic Lead produces `inspect existing API -> implement completed endpoint -> add tests`; dependency order, report/evaluation loop, and final completion are asserted. This proves orchestration, not actual repository modification by a Mock Worker. |

### Scope and extension points

| ID | Pri | Level | Scenario | Expected observable evidence |
| --- | --- | --- | --- | --- |
| `SCOPE-01` | P0 | integration/static | Prototype topology | Exactly one Commander, Lead, Worker, and Evaluator participate; no dynamic agent creation, P2P calls, or parallel Worker execution occurs. |
| `SCOPE-02` | P0 | static | Doctrine extension point | `.agents/doctrine/`, `.agents/roles/`, and `.agents/skills/` exist as replaceable structure; no invented doctrine policy is encoded as authoritative content. |
| `SCOPE-03` | P1 | static/dependency audit | Excluded infrastructure | Runtime has no required Kafka, Redis, Pub/Sub, Temporal, Vector DB, Graph DB, message bus, or distributed-runtime dependency. |

## Completion command evidence

The repository's final completion audit should capture fresh output for the package
manager's install, typecheck, unit test, integration test, build, and CLI smoke
commands. Node.js commands must use pnpm. The exact script names may follow the
repository manifest, but completion evidence should be equivalent to:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm <cli-script> run mission "Add completed todo endpoint"
```

The audit must additionally query the CLI smoke test's SQLite database and compare
the persisted terminal state and recent event with CLI output. A green unit test
alone is not evidence for persistence, restart, or the full C2 loop.
