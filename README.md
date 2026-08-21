# Command & Control Runtime v0.2 — Doctrine Enforcement

AI Agent を判断主体、Runtime を状態・権限・統制の唯一の所有者として分離した、Doctrine強制付きの最小 Command & Control（C2）実行基盤です。

```text
Human Goal → Commander Mission → Lead Plan / Delegation
                                  ↓
                         Worker bounded execution
                                  ↓
                      Evaluator independent assessment
                                  ↓
               Doctrine authorization + state machine
                                  ↓
                    SQLite state + append-only audit
```

実装仕様は [v0.2 Implementation Brief](./Command%20%26%20Control%20Runtime%20v0.2%20%E2%80%94%20Doctrine%20Enforcement%20Implementation%20Brief.md)、規範は [Decision Rights Doctrine](./.agents/doctrine/decision-rights.md) です。v0.1のC2ループを維持したまま、重要操作を決定論的な `ALLOW / DENY / ESCALATE` 判定へ通します。複数Worker、並列実行、動的Command Chain、Policy DSL、分散Runtimeなどはv0.2の対象外です。

## Doctrine Enforcement

- Decision TypeごとのHuman / Commander / Lead / Worker / Evaluator / Runtime境界
- Role Authority、Mission/Task単位のAuthority Grant、Resource Scope
- 親のEffective Authorityを越えない委譲、上位ConstraintとRisk Limitの継承
- Grantの取消・期限切れと、取消後・期限切れ後の権限行使拒否
- Decision Requestのschema、actor/role、状態、権限、Constraint、Risk検証
- 適切なDecision OwnerへのEscalationと、上位状態を自動変更しない分離
- Evaluatorの独立評価と、Runtimeだけが行うEvidenceベースの状態遷移
- Grant、Authorization、Violation、Escalation、Doctrine EventのSQLite監査履歴

## 必要環境

- Node.js 24以上
- Corepack（pnpm 10.30.3を使用）

```bash
corepack pnpm install --store-dir .pnpm-store
corepack pnpm run check
```

`node:sqlite` を使うため、外部DBサービスやSQLite native addonは不要です。

## CLI

Mock Agentによる完全なC2ループを実行します。

```bash
corepack pnpm start -- run mission "Add completed todo endpoint"
```

JSON出力とDBファイルを指定する例:

```bash
corepack pnpm --silent start -- run mission "Add completed todo endpoint" \
  --db ./c2-runtime.sqlite \
  --json
```

既存MissionはAgentを再実行せず、永続化された状態だけを読み取れます。

```bash
corepack pnpm start -- show mission <mission-id> \
  --db ./c2-runtime.sqlite
```

CLIは最低限、Mission、Status、Current Task、Recent Event、Escalation、Final Resultを表示します。

制御分岐を再現するMock scenario:

```bash
corepack pnpm start -- run mission "example" --scenario retry
corepack pnpm start -- run mission "example" --scenario replan
corepack pnpm start -- run mission "example" --scenario escalation
corepack pnpm start -- run mission "example" --scenario terminal-fail
```

## 構成

- `src/domain/`: Domain ModelとZod schema。Agent proposal、Authority、Decision Requestを検証
- `src/runtime/doctrine/`: Boundary Registry、Effective Authority、委譲、Constraint/Risk、Escalation、Enforcer
- `src/runtime/`: Doctrine認可を前段に持つC2 loop、Mission/Task状態機械、retry/replan/escalation
- `src/agents/`: Agent interfaceと決定論的Mock Agents
- `src/llm/`: provider非依存のStructured LLM interfaceと4役のadapter
- `src/storage/sqlite/`: v0.1状態、Authority Grant、認可・違反・Escalation ledger、atomic transition、append-only audit
- `src/cli/`: 最小実行・参照interface
- `tests/doctrine/`: Command BoundaryとDoctrine Invariantの決定論的テスト
- `tests/`: unit / integration / Scenario A-Hテスト
- `evals/prototype-v0.1-acceptance.md`: 要件と自動検証証拠の対応表
- `evals/doctrine-v0.2-acceptance.md`: v0.2要件と自動検証証拠の対応表

## 状態所有権と検証境界

AgentはMission proposal、Task plan、Task result/report、Evaluationを返します。すべての戻り値はRuntime境界で再度Zod validationを通ります。Agentの出力には永続ID、timestamp、Mission/Task statusを含められず、実際の状態遷移は明示的な状態機械とSQLite transactionだけが行います。

`SqliteStore`はRuntime内部で使うtrusted persistence adapterです。Agentへ渡すAPIではありません。Mission/Taskの作成APIは既存IDの上書きを拒否し、Task assignmentと状態遷移は実際に監査された`ALLOW`から作られるone-shot capabilityを要求します。Task完了時は保存済みReport、`EvaluationPassed`、Evaluator roleを再照合します。SQLiteファイル自体を管理できるOS/DB管理者からの改変防止は、このPrototypeのthreat boundary外です。

Workerの`success` reportだけでTaskは完了しません。Evaluatorが`pass/complete`を返し、それをRuntimeが検証した後に限って`completed`へ遷移します。

重要操作は `DecisionRequest` として `DoctrineEnforcer` に渡されます。Runtimeは認可結果とDoctrine EventをSQLiteへ記録し、`ALLOW`の場合だけ既存状態機械へ進みます。`DENY`と`ESCALATE`は状態を変更しません。

Taskの`authority.allowed`はcanonical action（例: `execution.method.select`、`execution.tool.select`、`code.read`、`code.edit`、`test.run`、`tool.select`、`report.submit`）だけが実Permissionへ変換されます。自然言語はAgent向けcontextとして保持しますが、強制ルールにはしません。機械可読Constraintは`prohibit:<action>`、`require:<context-key>`、`limit:<dimension><=<number>`を使い、`requiresApproval`は永続Approval modelがないv0.2ではfail-closedです。Missionの`riskLimits`に対する実測はTaskの`risk`を優先し、省略時はMission intentの`risk`を継承します。

通常の越境操作は暗黙にEscalationへ変換されません。変更要求は明示APIで作成し、記録済みtarget ownerだけが解決します。

```ts
const runResult = await runtime.run({ goal: "Implement the bounded change" });
const escalation = await runtime.escalateDecision({
  id: crypto.randomUUID(),
  missionId: runResult.mission.id,
  taskId: runResult.tasks[0]!.id,
  requesterId: "mock-worker",
  decisionType: "mission.scope.modify",
  reason: "The Mission scope must change",
  requestedChange: { scope: "broader" },
  targetRole: "commander",
  createdAt: new Date(),
});

if (escalation.result === "escalate") {
  await runtime.resolveEscalation({
    id: crypto.randomUUID(),
    escalationId: escalation.escalation.id,
    actorId: "mock-commander",
    reason: "Commander resolved the scope decision",
    createdAt: new Date(),
  });
}
```

Role上限、Resource scope、期限、現在のEffective Authorityと監査履歴も公開APIから扱えます。Runtimeへ差し替え可能なEnforcerは注入できず、設定可能なのはAgentのRole Authority上限だけです。HumanとRuntimeのRole Authorityは内部で固定され、custom設定に同名entryを含めても無視されます。

```ts
const globalPermissions = (...actions: string[]) =>
  actions.map((action) => ({
    action,
    resource: { type: "global" as const },
  }));

const roleAuthorities = [
  {
    subjectId: agents.commander.id,
    role: "commander",
    permissions: globalPermissions(
      "mission.*", "task.*", "plan.modify", "authority.delegate",
      "execution.*", "report.submit", "code.*", "public_api.modify",
      "test.run", "tool.select",
    ),
    constraints: [],
    riskLimits: [],
  },
  {
    subjectId: agents.lead.id,
    role: "lead",
    permissions: globalPermissions(
      "task.*", "plan.modify", "authority.delegate", "execution.*",
      "report.submit", "code.*", "public_api.modify", "test.run",
      "tool.select",
    ),
    constraints: [],
    riskLimits: [],
  },
  {
    subjectId: agents.worker.id,
    role: "worker",
    permissions: globalPermissions(
      "execution.*", "report.submit", "code.read", "code.edit",
      "public_api.modify", "test.run", "tool.select",
    ),
    constraints: [],
    riskLimits: [{ dimension: "cost", operator: "lte", value: 100 }],
  },
  {
    subjectId: agents.evaluator.id,
    role: "evaluator",
    permissions: globalPermissions("evaluation.*"),
    constraints: [],
    riskLimits: [],
  },
] satisfies readonly RoleAuthority[];

const runtime = new CommandControlRuntime(store, agents, {
  doctrine: {
    // custom設定時は、実行に参加する全Agent actor分を列挙する。
    // Human / Runtimeの不可欠な権限はRuntime内部で補完される。
    roleAuthorities,
  },
});

const effective = await runtime.resolveEffectiveAuthority("mock-worker", {
  missionId,
  taskId,
  role: "worker",
});

await runtime.delegateAuthority({
  issuerId: "mock-lead",
  subjectId: "mock-worker",
  missionId,
  taskId,
  permissions: [
    { action: "code.edit", resource: { type: "path", pattern: "src/auth/**" } },
  ],
  constraints: [],
  riskLimits: [],
  expiresAt: new Date(Date.now() + 60_000),
});

const audit = {
  grants: store.listAuthorityGrants(missionId),
  authorizations: store.listAuthorizationRecords(missionId),
  violations: store.listDoctrineViolations(missionId),
  escalations: store.listEscalations(missionId),
  events: store.listEvents(missionId),
};
```

## LLM Agentへの差替え

`StructuredLlmProvider`を実装して、同じinterfaceのadapterをRuntimeへ注入します。providerはSDK・認証・通信を担当し、role adapterは入力圧縮、JSON Schema提示、出力validationを担当します。

```ts
import {
  CommandControlRuntime,
  LlmLeadAgent,
  SqliteStore,
  createMockAgents,
  type StructuredLlmProvider,
} from "./src/index.js";

const provider: StructuredLlmProvider = {
  async generate(request) {
    // request.outputSchemaに準拠したJSONをLLM SDKから返す
    return callYourProvider(request);
  },
};

const agents = createMockAgents();
const runtime = new CommandControlRuntime(
  new SqliteStore("runtime.sqlite"),
  { ...agents, lead: new LlmLeadAgent(provider) },
  { agentImplementations: { lead: "llm" } },
);
```

特定vendorのAPI、model、credentialはPrototype仕様で指定されていないため、このリポジトリには固定していません。テストではfake providerを通じて、MockとLLM adapterをRuntime変更なしで交換できることを検証します。

## 主なコマンド

```bash
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
corepack pnpm run check
```
