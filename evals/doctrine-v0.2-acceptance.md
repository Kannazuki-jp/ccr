# Doctrine Enforcement v0.2 acceptance evidence

この文書は、`Command & Control Runtime v0.2 — Doctrine Enforcement
Implementation Brief.md` の §42–44 と実装・自動テストの対応表です。最終ゲートは
`corepack pnpm run check` と、build済みCLIのsmoke testです。

## 判定規則

- Domain schemaや型の存在だけではRuntime強制の証拠としない。
- `ALLOW / DENY / ESCALATE` は戻り値だけでなく、SQLiteのAuthorization、Violation、
  Escalation、Event履歴も確認する。
- State変更要件は、Doctrine認可と既存State Machineの両方を通る統合テストで確認する。
- Agentの自己申告は完了証拠としない。Report、Evaluator PASS、Runtime transitionの順序を確認する。

## §42 Doctrine Compliance Tests

| 要件群 | 主な自動証拠 |
| --- | --- |
| Command Boundaries | `tests/doctrine/command-boundary.test.ts` |
| Delegation / Resource Scope / Revocation / Expiration | `tests/doctrine/delegation.test.ts` |
| Effective Authority / Constraint / Risk Limit | `tests/doctrine/constraints-authority.test.ts` |
| Evaluator Isolation / State Machine composition | `tests/doctrine/evaluator-state-escalation.test.ts` |
| Escalation routing and persistence | `tests/doctrine/evaluator-state-escalation.test.ts`, `tests/integration/doctrine-runtime.test.ts` |
| Runtime ALLOW / DENY / ESCALATE audit | 上記Doctrine testsと`tests/unit/sqlite-store.test.ts` |

## §43 Required Integration Scenarios

| Scenario | 期待結果 | 自動証拠 |
| --- | --- | --- |
| A — Normal Autonomous Execution | Workerが境界内で自律実行し、Evaluator PASS後にRuntimeが完了 | `doctrine-runtime.test.ts` Scenario A |
| B — Worker Crosses Task Boundary | Plan変更要求をLeadへEscalateし、状態は不変 | Scenario B |
| C — Mission Scope Change | Mission Scope変更要求がCommanderへ到達し、状態は不変 | Scenario C |
| D — Goal Change Required | Lead/CommanderのGoal変更要求をHumanへEscalateし、Goalは不変 | Scenario D |
| E — Invalid Delegation | 親のEffective Authority外を`INVALID_DELEGATION`で拒否 | Scenario E |
| F — Constraint Inheritance | Commander由来禁止ConstraintをLeadが解除できない | Scenario F |
| G — Authority Revocation | 取消前ALLOW、取消後`REVOKED_AUTHORITY` | Scenario G |
| H — Evaluator Isolation | Evaluatorのstate mutationを拒否し、Runtime transitionだけ成功 | Scenario H |

## §44 Acceptance Criteria traceability

| 領域 | 実装 | 永続化・テスト証拠 |
| --- | --- | --- |
| Authority | `src/domain/authority.ts`, `permission.ts`, `risk-limit.ts`; `AuthorityResolver` | `constraints-authority.test.ts`, `delegation.test.ts` |
| Delegation | `delegation-validator.ts`, `DoctrineEnforcer.delegate/revoke` | `delegation.test.ts`, `sqlite-store.test.ts` |
| Command Boundary | `boundary-registry.ts`, `DoctrineEnforcer.authorize` | `command-boundary.test.ts` |
| Authorization | `decision-request.ts`, `authorization-result.ts`, enforcement pipeline | 全Doctrine tests、Scenario A–H |
| Escalation | `escalation-router.ts`, `DoctrineEnforcer.escalate/resolveEscalation` | escalation unit tests、Scenario B–D |
| Evaluation | Evaluator Decision RequestsとRuntime-owned completion wrapper | evaluator/state tests、Scenario A/H、既存ownership tests |
| State | Doctrine state checkの後に既存State Machineを実行 | evaluator/state tests、state-machine tests、Scenario H |
| Auditability | `authority_grants`, `constraints`, `risk_limits`, `authorization_results`, `doctrine_violations`, `escalations`, `events` | `sqlite-store.test.ts`のatomicity、append-only、reopen、v1 migration tests |
| v0.1 integration | `CommandControlRuntime`が通常runで既定の`DoctrineEnforcer`を使用 | `runtime.test.ts`, `runtime-ownership.test.ts`, `cli.test.ts`, Scenario A |

## Completion snapshot

2026-08-20（Asia/Tokyo）の最終実行結果:

- `corepack pnpm run check`: PASS（10/10 test files、0 fail / skip / todo、line 94.25%、branch 85.77%、function 93.48%）
- TypeScript typecheck / build: PASS
- build済みCLI happy path: exit 0、Mission `completed`、48 Authorizationすべて`ALLOW`、Violation/Escalation 0
- build済みCLI escalation path: exit 0、Mission `escalated` / Task `blocked`、`AuthorizationEscalated`と`EscalationCreated`を各1件保存
- package self-referenceによる公開export smoke: PASS
- `git diff --check`: PASS
