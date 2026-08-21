# Command & Control Runtime v0.3 — Controlled Repository Execution Implementation Brief

## 1. 文書の位置付け

本書は、`Command & Control Runtime v0.2 — Doctrine Enforcement`に、実Repositoryを対象とする最小Execution Planeを追加するための規範仕様である。

規範となるDecision Rights Doctrineは引き続き`.agents/doctrine/decision-rights.md`であり、本書はDoctrineを変更・拡張しない。本書は、既存のWorker Boundaryに属するTool選択と権限内変更を、Runtimeが強制可能な実行契約へ落とす。

キーワード`MUST`、`MUST NOT`、`SHOULD`は必須、禁止、強い推奨を表す。

---

## 2. PurposeとCompletion Definition

v0.3の目的は、Agentの提案したRepository操作を、Doctrine認可、境界付き実行、永続Evidence、独立評価、Runtime状態遷移から成る一つの統制loopとして実行できるようにすることである。

中心Invariantは次の通りである。

```text
Agent proposes ToolRequest.
Runtime authorizes.
ToolBroker executes.
Runtime records ToolEvidence.
Evaluator assesses Evidence.
Runtime transitions State.
```

v0.3は次をすべて満たしたときに完成とする。

1. `Workspace`外へ出ない`repo.list`、`repo.search`、`repo.read`、`repo.patch`と、allowlist済み`test.run`を実行できる。
2. 全ToolRequestは実行前に既存Doctrine Enforcerを通り、`ALLOW`だけがToolBrokerへ到達する。
3. 実行された全ToolRequestについて、成功、失敗、timeoutを含むToolEvidenceがappend-onlyに永続化される。
4. Workerの最終報告、EvaluatorのPASS、保存済みEvidence、TaskのEvidence Requirementがそろわない限りTaskは`completed`にならない。
5. Scenario A–Jが決定論的なintegration testとして通り、v0.2の全テストが回帰しない。

Promptに「Workspace外へ出ない」と書くだけ、Workerの`success`を信頼するだけ、自由shellの実行結果を文字列で保存するだけでは完成ではない。

### 2.1 Mandatory Invariants

以下は設計指針ではなくRuntimeが強制し、自動テストで破壊不能性を示すInvariantである。

- `Worker`はfilesystemやprocessへ直接アクセスしない。
- `ToolBroker`は`ALLOW`された操作だけを実行する。
- `DENY`と`ESCALATE`では副作用を発生させない。
- `Workspace`外のpathへアクセスできない。
- `Worker`の`success`申告だけでは`Task`を`completed`にしない。
- `ToolEvidence`が永続化される前に`Task`を完了しない。
- `Evaluator`はStateを直接変更しない。
- Runtimeだけがprotected `State Transition`を実行する。

---

## 3. v0.2 Control Planeとの責務境界

v0.2は次を所有し続ける。

- Goal、Mission、Task、Report、Evaluation、Decision、Event
- Role Authority、Mission/Task Delegation、Constraint、Risk Limit
- `ALLOW / DENY / ESCALATE`
- protected State TransitionとEscalation routing
- Runtime-owned ID、actor、status、timestamp

v0.3は次だけを追加する。

- Runtime設定の`Workspace`
- ToolRequestとToolEvidence
- ResourceScopeを実filesystem pathまたはtest commandへ写像するresolver
- 5つのbuilt-in toolを持つToolBroker
- ToolEvidenceをWorkerとEvaluatorへ戻す逐次tool loop
- Evidence Requirementを使う決定論的Task completion gate

責務分離は次の通りである。

| 主体 | v0.3で行うこと | 行わないこと |
| --- | --- | --- |
| Worker | Toolの選択、入力の提案、Evidenceを見た局所的再試行、最終Reportの提案 | filesystem/processへの直接アクセス、認可、状態変更 |
| Runtime | trusted contextの付与、認可、loop/limit管理、永続化、状態遷移 | HOWやpatch内容の生成、評価判定 |
| ToolBroker | 検証済みRequestの実行、観測結果の返却 | Agentとの会話、権限判断、状態変更、永続化 |
| Evaluator | 保存済みEvidenceと成功基準の評価、PASS/FAILと推奨 | Tool実行、State変更 |
| SQLite Store | Request、Evidence、Eventの永続化とappend-only保証 | 認可、評価、実行 |

既存の`WorkerAgent.execute(task, context)`一回呼出しはv0.2互換経路に留める。Controlled Repository Executionでは後述の`nextTurn` protocolを使い、旧経路を実Repository toolへ接続してはならない。

---

## 4. Threat Boundary

### 4.1 防御対象

Runtimeは、誤作動または敵対的なAgent出力が次を試みるものとして扱う。

- `..`、absolute path、separator差、symlinkを使うWorkspace escape
- 許可されていないpathやToolへのアクセス
- patch対象のすり替え、stale contentへの上書き
- arbitrary shell、未登録command、任意argumentの実行
- environment、credential、networkへのアクセス要求
- 成功の虚偽申告、Evidence IDの捏造、失敗したtestの無視
- Tool回数、出力量、ファイルサイズ、timeoutの消費
- `DENY`または`ESCALATE`後の副作用実行

ToolRequest、LLM出力、Repository内のpath文字列とfile contentはuntrusted inputである。

### 4.2 Trusted Computing Base

以下はtrustedとする。

- Runtime process、Doctrine Enforcer、ToolBroker、SQLite Storeの実装
- Runtime起動者が与えるWorkspace rootとTool Policy
- allowlistへ登録されたtest executable、固定argv、およびtest対象Repository
- OS filesystem APIとSQLite

### 4.3 明示的に保証しない境界

v0.3はOS sandbox、container、VMではない。allowlist済みtest command自身またはRepository内のtest codeが悪意を持つ場合、そのprocessによるfilesystem/network accessを完全には封じ込めない。この保証が必要なら、将来のsandbox adapterでToolBrokerの下を置換する。

同様に、Runtimeと同じOS user、DB管理者、同時にWorkspaceを書き換える外部processからの改ざん、完全なcrash recoveryは対象外である。これらを理由に、Agentへ自由shellやcredentialを渡してはならない。

---

## 5. Workspace contractとroot boundary

`Workspace`はAgent proposalではなくRuntime設定で生成する。

```ts
interface Workspace {
  readonly id: string;
  readonly missionId: string;
  readonly rootPath: string;          // Runtime-only absolute path
  readonly canonicalRootPath: string; // startup時のrealpath
  readonly maxReadBytes: number;
  readonly maxPatchBytes: number;
  readonly maxSearchResults: number;
  readonly testCommands: Readonly<Record<string, TestCommandPolicy>>;
}

interface TestCommandPolicy {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;               // Workspace-relative
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
}
```

必須規則：

1. `rootPath`は起動時に一度`realpath`し、存在するdirectoryでなければ起動を拒否する。
2. AgentとLLMへabsolute rootを渡さない。全Tool input/outputは`/`区切りのWorkspace-relative pathを使う。
3. pathは空文字、NUL、absolute path、drive/UNC path、空segment、`..` segmentを拒否する。`.`はWorkspace rootそのものを指定する場合だけ許可する。
4. resolverは既存の各path componentを`lstat`/`realpath`し、最終canonical pathが`canonicalRootPath`自身またはそのseparator境界内であることを確認する。文字列prefixだけで判定しない。
5. create対象は最も近い既存parentを同様に検証する。symlink解決後にroot外となるpathは`DENY`とする。
6. patch直前にも対象またはparentを再検証する。v0.3は外部hostile processとの完全なTOCTOU耐性を主張しない。
7. `.git/**`、credential policyで禁止されたpath、ToolBroker内部fileは、path scopeが広くても常に拒否する。
8. Workspaceの作成、root変更、test command登録はv0.3 Agent APIに公開しない。

`ResourceScope`の`path.pattern`とTool input pathは別物である。前者はAuthorityの上限、後者は今回の対象であり、resolverは両方をcanonicalなWorkspace-relative pathへ変換してからscope包含を判定する。

---

## 6. ToolRequest Domain contract

Agentはtool名とinputだけを提案する。Runtimeは現在のTaskからidentity fieldsを上書きして、次の永続可能な`ToolRequest`を作る。

```ts
type ToolName =
  | "repo.list"
  | "repo.search"
  | "repo.read"
  | "repo.patch"
  | "test.run";

interface ToolRequest<TName extends ToolName = ToolName> {
  readonly id: string;          // Runtime assigned UUID
  readonly missionId: string;   // current persisted Mission
  readonly taskId: string;      // current persisted Task
  readonly actorId: string;     // registered Worker
  readonly attempt: number;
  readonly sequence: number;    // Task attempt内で単調増加
  readonly tool: TName;
  readonly input: ToolInput<TName>;
  readonly requestedAt: Date;   // Runtime clock
}
```

Tool inputはstrict discriminated unionとし、未知fieldを拒否する。

```ts
type ToolInput<TName extends ToolName> =
  TName extends "repo.list" ? {
    path: string;
    maxDepth: number; // 0..8
  } : TName extends "repo.search" ? {
    query: string;    // literal UTF-8 text, regexではない
    paths: readonly string[];
    maxResults: number;
  } : TName extends "repo.read" ? {
    path: string;
    offset: number;   // byte offset
    limit: number;    // byte count
  } : TName extends "repo.patch" ? {
    path: string;
    operation: "create" | "update" | "delete";
    content?: string;             // create/update only, UTF-8 complete replacement
    expectedSha256?: string;      // update/deleteで必須
  } : {
    commandId: string;            // Workspace policy key only
  };
```

`missionId`、`taskId`、`actorId`、`attempt`、`sequence`、timestampをAgentから受理してはならない。schema不正はToolBrokerへ渡さず`AgentOutputRejected`として記録する。

---

## 7. ToolEvidence Domain contract

ToolEvidenceはToolBrokerの観測をRuntimeが正規化したappend-only recordである。

```ts
interface ToolEvidence<TName extends ToolName = ToolName> {
  readonly id: string;
  readonly requestId: string;
  readonly authorizationId: string; // persisted ALLOW record
  readonly missionId: string;
  readonly taskId: string;
  readonly actorId: string;
  readonly attempt: number;
  readonly sequence: number;
  readonly tool: TName;
  readonly status: "succeeded" | "failed" | "timed_out";
  readonly observation: ToolObservation<TName>;
  readonly sideEffects: readonly ToolSideEffect[];
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly outputSha256: string;
  readonly truncated: boolean;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

interface ToolSideEffect {
  readonly path: string;
  readonly operation: "create" | "update" | "delete";
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly applied: boolean;
}
```

観測型は最低限次を含む。

- `repo.list`: sorted entries `{ path, kind, size }[]`
- `repo.search`: sorted matches `{ path, line, column, excerpt }[]`とscanned file count
- `repo.read`: content、byte range、total bytes、content SHA-256
- `repo.patch`: operation、before/after SHA-256、bytes
- `test.run`: commandId、exit code/signal、bounded stdout/stderr、各SHA-256

共通規則：

1. Evidenceのidentityと時刻はRuntime/ToolBrokerだけが作る。
2. Evidenceは対応する保存済み`ALLOW` Authorizationを必ず参照する。
3. `DENY`と`ESCALATE`ではToolBrokerを呼ばず、ToolEvidenceを捏造しない。非実行の証拠はAuthorization/Eventである。
4. 実行開始後は成功、tool-level failure、timeoutのいずれでもEvidenceを作る。
5. `outputSha256`はcanonical JSON serializationしたobservation、sideEffects、errorから計算する。
6. Worker/Evaluatorが返したEvidence IDや内容を保存済みrecordの代わりに使わない。
7. 大きなoutputはpolicy上限で切り詰め、hash、元byte数、`truncated: true`を残す。

---

## 8. ResourceScopeとfilesystem/toolの対応

ToolRequestはauthorization前に、次のcanonical permissionへ決定論的に変換する。

| Tool | action | resource |
| --- | --- | --- |
| `repo.list` | `code.read` | `{ type: "path", pattern: resolvedPath }` |
| `repo.search` | `code.read` | 各resolved search root。全rootが許可されなければRequest全体をDENY |
| `repo.read` | `code.read` | `{ type: "path", pattern: resolvedPath }` |
| `repo.patch` | `code.edit` | `{ type: "path", pattern: resolvedPath }` |
| `test.run` | `test.run` | `{ type: "tool", tool: commandId }` |

`execution.tool.select`はTool選択権であり、対象Repositoryを操作する権限の代わりではない。したがって、実行には`execution.tool.select`に加え、上表のaction/resourceがEffective Authorityに含まれなければならない。

path scopeはsegment単位で扱う。`src/auth/**`は`src/auth`以下を含むが、`src/authentication`を含まない。`global` scopeはDoctrine上の上限になり得るが、Workspace root、reserved path、credential policyを越えない。

`repo.search`の複数rootや`repo.patch`の単一targetはRequest全体を事前検証する。一部だけ許可して部分実行してはならない。

---

## 9. ToolBroker authorization pipeline

Runtimeは各Worker turnで次の順序をMUSTで守る。

```text
1. Parse WorkerTurnProposal
2. Bind trusted Mission / Task / Worker / attempt / sequence
3. Parse strict ToolRequest input
4. Resolve Workspace path / command and derive Permission
5. Persist ToolRequestProposed event and request record
6. DoctrineEnforcer.authorize(...)
7. Persist Authorization result
8a. DENY      -> no execution; return denial control result
8b. ESCALATE  -> no execution; persist escalation; block Task; escalate Mission
8c. ALLOW     -> invoke ToolBroker with an internal one-shot permit
9. ToolBroker executes exactly once with timeout/output limits
10. Runtime constructs and persists ToolEvidence + ToolExecuted event
11. Only after commit, return a clone of Evidence to Worker
```

ToolBrokerのpublic APIはraw `ToolRequest`だけでは実行できず、Doctrine Enforcerの保存済みALLOWからRuntime内部で発行するone-shot permitを要求する。permitはrequest ID、authorization ID、tool、resourceにbindし、一度だけconsumeできる。既存`transition-permit.ts`と同様、発行/consume capabilityはpackage public exportに含めない。

Authorization/persistence failureではfail closedとする。実行前の失敗は副作用ゼロである。副作用後にEvidence commitが失敗した場合、Taskを完了せずMissionを`blocked`へ移し、mutationを自動再実行しない。完全なcrash recoveryはNon-goalだが、unknown outcomeを成功扱いしてはならない。

---

## 10. Runtime-managed Worker tool loop

Controlled execution用Worker contractを追加する。

```ts
type WorkerTurnProposal =
  | { readonly kind: "tool_request"; readonly tool: ToolName; readonly input: unknown }
  | { readonly kind: "final"; readonly result: TaskResult };

interface ControlledWorkerAgent extends RuntimeAgent {
  nextTurn(input: WorkerTurnInput): Promise<WorkerTurnProposal>;
}

interface WorkerTurnInput {
  readonly task: Task;
  readonly context: WorkerContext;
  readonly evidence: readonly ToolEvidenceSummary[];
  readonly controlResults: readonly ToolControlResult[];
  readonly remainingToolRequests: number;
}
```

loop規則：

- Runtimeだけがturn numberとrequest budgetを管理する。
- Workerには保存commit済みEvidenceだけを順序付きで渡す。
- Workerは一turnに一つのToolRequestまたはfinal resultだけを返す。
- `DENY`は副作用を起こさずcontrol resultとして次turnへ返し、budgetを1消費する。
- tool failure/timeoutはEvidenceとして次turnへ返し、Workerは残budget内で局所的に再試行できる。
- `ESCALATE`は直ちにloopを停止し、Task=`blocked`、Mission=`escalated`とする。
- final result後は新しいToolRequestを受け付けず、Report保存とEvaluationへ進む。
- malformed output、provider exception、limit exhaustionは既存agent-boundary failureとRuntime state machineを通す。

Workerへ`fs`、`child_process`、Store、ToolBroker instance、absolute Workspace root、credentialを渡してはならない。custom Worker implementationも同じinterface境界を守る。

---

## 11. StructuredLlmProviderとの接続

`LlmOperationSchema`へ`worker-turn`を追加し、Controlled Worker adapterは毎turn次を行う。

1. `WorkerTurnInput`をJSON-safeなsummaryへ圧縮する。
2. `WorkerTurnProposal`のJSON Schemaを`StructuredLlmProvider.generate`へ渡す。
3. provider outputをRuntime境界で再度Zod parseする。
4. ToolEvidenceは保存済みrecordから生成し、LLMが返したEvidenceを採用しない。

system promptは「利用可能toolと入力schema」「remaining limit」「absolute pathやshellを要求できないこと」を説明してよいが、security enforcementをpromptへ依存させない。

既存`execute-task` operationはMock/legacy回帰用に維持できる。ただし`Workspace`が設定されたcontrolled modeでは`worker-turn`以外を実Repository executionへ使用してはならない。provider SDK、model、API key、network transportはv0.3の対象外である。

---

## 12. 最小Tool set

### 12.1 `repo.list`

- Directory treeをlexicographic順で返す。
- `maxDepth`、entry count、output bytesをpolicyで制限する。
- symlinkはentryとして示してよいが、自動追跡しない。
- missing path、non-directory、permission errorはfailed Evidenceとする。

### 12.2 `repo.search`

- UTF-8 text fileに対するliteral searchのみを行う。
- binary、reserved、scope外fileを読まない。
- path、line、column順の決定論的結果を返す。
- query length、file bytes、result countを制限し、上限到達をEvidenceに示す。

### 12.3 `repo.read`

- 一fileのbounded byte rangeを読む。
- UTF-8 decode不能、directory、上限超過はfailed Evidenceとする。
- contentと全file SHA-256を返し、patchのoptimistic concurrencyへ使えるようにする。

### 12.4 `repo.patch`

- 一Requestにつき一つのUTF-8 text fileだけをcreate/update/deleteする。
- update/deleteは現在内容の`expectedSha256`一致を必須とし、stale writeを副作用前に拒否する。
- createは既存pathなら失敗する。update/deleteは不存在なら失敗する。
- create/updateの`content`はcomplete replacementであり、shell、patch command、arbitrary diff parserを起動しない。
- create/updateは同一directoryのtemporary file、flush、atomic renameを用いる。既存file modeはupdateで維持し、createはpolicy既定modeを用いる。
- `.git/**`、symlink file、symlink経由parent、credential policy対象、max bytes超過を拒否する。
- 成功Evidenceにbefore/after hashとapplied side effectを記録する。

### 12.5 `test.run`

- Agentが指定できるのは`commandId`だけである。
- Runtime設定のexact executable、fixed argv、relative cwd、timeout、fixed envを使う。
- `spawn`は`{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }`相当とする。
- host environmentを継承せず、policyで明示した最小envだけを渡す。credential-bearing envを渡さない。
- stdout/stderrをbounded captureし、exit 0だけを`succeeded`とする。non-zeroは`failed`、deadline超過はprocess groupを終了して`timed_out`とする。
- package install、network fetch、任意引数、command substitutionをbuilt-in toolとして提供しない。

---

## 13. arbitrary shell、network、credential access

- `shell.run`、terminal、eval、script text、任意executableはv0.3 ToolNameに存在しない。未知toolはschemaで拒否する。
- `test.run`を自由shellのescape hatchにしてはならない。command/argv/cwd/envはoperator policyの固定値である。
- RuntimeはAgent向けnetwork toolを提供しない。LLM provider自身の通信はControl Plane adapterの責務であり、Worker tool authorityとは別境界である。
- ToolBrokerはprocess environment、home directory、SSH agent、cloud metadata、keychainをAgentへ公開しない。
- `.env*`、`*.pem`、`*.key`、credential policyで列挙したpathは既定DENYとする。必要な読取はv0.3外のoperator設定変更を要し、Agent自身は解除できない。
- approval-required shell/network/credential requestは実行してから報告せず、既存Doctrineの`ESCALATE`として実行前に停止する。Human Approval lifecycleの完結はNon-goalである。

---

## 14. Evidence persistenceとappend-only audit

SQLite schemaへ最低限次を追加する。

```text
workspaces
  id, mission_id, root_fingerprint, policy_json, created_at

tool_requests
  id, mission_id, task_id, actor_id, attempt, sequence,
  tool, input_json, requested_at

tool_evidence
  id, request_id, authorization_id, mission_id, task_id, actor_id,
  attempt, sequence, tool, status, observation_json, side_effects_json,
  started_at, finished_at, duration_ms, output_sha256, truncated, error_json
```

規則：

1. `tool_requests`と`tool_evidence`はUPDATE/DELETE triggerでappend-onlyにする。
2. `(task_id, attempt, sequence)`、`request_id`、`authorization_id`の一意性をDBでも強制する。
3. foreign keyでMission、Task、Authorization、Requestを結ぶ。
4. Request proposal/Event、Authorizationは実行前にcommitする。
5. Evidenceと`ToolExecutionSucceeded|Failed|TimedOut` Eventは一transactionでcommitする。
6. Evidence queryはMission/Task/attempt/sequence順の決定論的順序を持つ。
7. DB reopen後もhash、side effect、test exit、失敗/timeoutが復元できる。
8. authorizationなしのEvidence、別TaskのEvidence、duplicate Evidenceを拒否する。

file contentやstdoutにsecretが含まれ得るため、policy上限とreserved pathを適用する。ただしv0.3は一般的secret detection/redaction engineを導入しない。

---

## 15. Evidence-based Evaluation

Evaluator inputを次へ拡張する。

```ts
interface EvidenceEvaluationInput {
  readonly task: Task;
  readonly result: TaskResult;
  readonly evidenceRequirements: TaskEvidenceRequirements;
  readonly evidence: readonly ToolEvidenceSummary[];
}

interface TaskEvidenceRequirements {
  readonly requiredTools: readonly ToolName[];
  readonly requiredPaths: readonly string[];
  readonly requireMutation: boolean;
  readonly requireSuccessfulTest: boolean;
}
```

LeadはTask計画時にrequirementsを提案し、RuntimeがTask scope/authorityに照らして保存する。既定値を空にして暗黙に成功扱いしてはならず、controlled modeのTaskは最低一つのrequired toolを持つ。

Evaluatorは保存済みEvidenceだけを評価し、各success criterionについて理由を示す。failed/timed-out Evidenceを成功と解釈せず、必要なpath、mutation、testの不足をFAILにする。EvaluatorのPASSはassessmentであり、completion permitではない。

---

## 16. Evidence-based Task Completionとv0.2 State Machine統合

RuntimeはEvaluator PASS後、Taskを`completed`へ遷移する直前に次をすべて決定論的に再照合する。

- Task/Report/Evaluationが同じmission、task、attemptを参照する。
- Workerのfinal Reportが保存済みで、status=`success`である。
- 参照Evidenceが全てDBに存在し、同じTask/attemptに属する。
- 各Evidenceに同じRequestと事前保存済みALLOWが存在する。
- required tool/pathがsuccessful Evidenceで満たされる。
- `requireMutation`なら`repo.patch`の`applied: true` side effectがある。
- `requireSuccessfulTest`なら最新の関連`test.run`がexit 0である。後続patchがある場合、そのpatch後のtestでなければならない。
- unresolved `ESCALATE`、unknown execution outcome、未完了ToolRequestがない。
- 保存済みEvaluator resultがPASS/completeである。
- 既存Doctrine authorizationとState Machine transitionがALLOWする。

一つでも不足すれば`TaskCompletionRejected` Eventを保存し、Taskをcompletedにしない。EvaluatorはStateを直接変更できず、ToolBrokerもStoreもtransition permitを発行できない。Runtimeだけが既存protected transitionを実行する。

既存Mission loopへは、Worker実行部分をcontrolled tool loopに置換する形で統合し、plan、replan、retry、escalation、terminal failureの状態集合を増やさない。

---

## 17. Failure、DENY、ESCALATE、timeout、tool limit

| 条件 | Tool副作用 | Evidence | 直後のState | 必須Event/record |
| --- | --- | --- | --- | --- |
| malformed proposal | なし | なし | agent-boundary failure規則 | `AgentOutputRejected` |
| Authorization DENY | なし | なし | Taskは`running`のまま。次turn可 | Authorization DENY、`AuthorizationDenied` |
| Authorization ESCALATE | なし | なし | Task=`blocked`, Mission=`escalated` | Authorization、Escalation、既存state events |
| Tool validation/runtime failure | なし、またはEvidence記載の実際値 | `failed` | Taskは`running`。次turn可 | `ToolExecutionFailed` |
| timeout | patch以外はなし。観測値を正確に記録 | `timed_out` | Taskは`running`。次turn可 | `ToolExecutionTimedOut` |
| failing test | Repository変更なし | `failed`, exit!=0 | Taskは`running`。final時はcompletion拒否 | `ToolExecutionFailed` |
| request limit exhaustion | 追加副作用なし | 追加Evidenceなし | Task=`failed`, Mission=`failed` | `ToolLimitExhausted`, state events |
| Evidence persist failure after side effect | 不明または適用済み | commitなし | Task=`blocked`, Mission=`blocked` | 保存可能なら`EvidencePersistenceFailed` |

既定上限はTaskごとの全attempt合計20 ToolRequest、単一test 120秒、その他tool 10秒とする。Runtime optionでより狭くできる。上限値をAgentが増やせてはならない。DENY、失敗、timeoutもlimitを消費する。

`repo.patch`は同期的なbounded file operationとし、timeoutによる中途半端なmutationを設計しない。test timeoutでprocess terminationが確認できない場合は完了不能とする。

---

## 18. Implementation Orderと後続Issue依存関係

後続Issueは次のwork package単位で作成し、順序を守る。各packageは記載した自動テストとpublic contractまでを完成条件とする。

1. **V03-01 Domain / Workspace contract**
   依存: v0.2。Workspace、ToolRequest/Evidence、WorkerTurn、Evidence Requirement schemaとunit tests。
2. **V03-02 Path resolver / read-only broker**
   依存: V03-01。root/symlink/credential boundary、`repo.list/search/read`、one-shot execution permit。
3. **V03-03 Persistence / audit**
   依存: V03-01。migration、append-only Request/Evidence、atomic Event、reopen tests。
4. **V03-04 Structured patch**
   依存: V03-02, V03-03。optimistic SHA、atomic single-file create/update/delete、side-effect Evidence。
5. **V03-05 Allowlisted test runner**
   依存: V03-02, V03-03。shell=false、fixed argv/env/cwd、timeout/output Evidence。
6. **V03-06 Runtime Worker tool loop / LLM adapter**
   依存: V03-01〜V03-05。authorization pipeline、limit、`worker-turn`、Mock/Fake provider tests。
7. **V03-07 Evidence evaluation / completion gate**
   依存: V03-03, V03-06。Evaluator input、fresh-test規則、protected completion integration。
8. **V03-08 Scenario A–J / CLI / acceptance evidence**
   依存: V03-01〜V03-07。全integration scenario、回帰、README、smoke。

同時実装できるのはV03-02完了後のV03-04とV03-05だけである。V03-06をToolBroker未完成のfakeだけで「完成」としてはならない。

想定配置：

```text
src/domain/{workspace,tool-request,tool-evidence,worker-turn}.ts
src/runtime/tools/{broker,path-resolver,permission-mapper,execution-permit}.ts
src/storage/sqlite/sqlite-store.ts
src/agents/interfaces.ts
src/llm/{provider,agents}.ts
src/runtime/runtime.ts
tests/tools/
tests/integration/controlled-repository-execution.test.ts
```

---

## 19. Required Integration Scenarios

Scenario A–Jの規範的な入力、Authorization、side effect、State、Event、Evidenceは`evals/controlled-repository-execution-v0.3-acceptance.md`に定義する。最低限次を含む。

- A — Read-only repository inspection
- B — Allowed in-scope patch
- C — Out-of-scope path access
- D — Symlink boundary escape
- E — Allowed test execution
- F — Failing test prevents completion
- G — Approval-required operation escalates before execution
- H — Worker claims success without sufficient Evidence
- I — Tool limit exhaustion
- J — Full repository change completes with durable audit

Unit testの寄せ集めをScenario testの代わりにしてはならない。各Scenarioは実SQLite、temporary Workspace、実ToolBroker、Runtime loopを通し、DB reopen後のrecordまで必要に応じて検証する。

---

## 20. Acceptance Criteria

次を全て満たすこと。IDはacceptance文書と後続自動テストの対応keyである。

### Contract / Boundary

- [ ] **AC-01** v0.3 Purpose、Completion、v0.2との境界が本書どおりである。
- [ ] **AC-02** Threat Boundaryとtrusted/non-trusted要素が実装docsに一致する。
- [ ] **AC-03** Workspace rootはRuntime-ownedでcanonical化され、外部pathとsymlink escapeを拒否する。
- [ ] **AC-04** ToolRequestはstrict schemaで、identity/timestampをRuntimeだけが付与する。
- [ ] **AC-05** ToolEvidenceはRequest、ALLOW Authorization、Task attemptへbindされる。
- [ ] **AC-06** ResourceScopeからpath/commandへのmappingがsegment単位でfail closedする。

### Authorization / Execution

- [ ] **AC-07** 全RequestがToolBroker実行前にDoctrine認可・永続化を通る。
- [ ] **AC-08** ToolBrokerはone-shot permitを持つALLOW Requestだけを一度実行する。
- [ ] **AC-09** DENYとESCALATEはfilesystem/process副作用を起こさない。
- [ ] **AC-10** 5 toolが§12のbounded contractを満たす。
- [ ] **AC-11** arbitrary shell/network/credential accessをbuilt-in capabilityとして公開しない。
- [ ] **AC-12** test.runはoperator allowlist、fixed argv/cwd/env、shell=false、timeoutを強制する。

### Evidence / State

- [ ] **AC-13** 実行したRequestのsuccess/failure/timeout EvidenceとEventがatomicに永続化される。
- [ ] **AC-14** Request/Evidence/Event ledgerがappend-onlyで、reopen後も照合できる。
- [ ] **AC-15** Workerは保存済みEvidenceだけを次turnで受け取り、ToolBrokerへ直接アクセスできない。
- [ ] **AC-16** Evaluatorは保存済みEvidenceとrequirementsを評価し、Stateを変更できない。
- [ ] **AC-17** Worker successまたはEvaluator PASS単独ではTask completionを許可しない。
- [ ] **AC-18** 最新successful test、mutation、path/tool requirementをRuntime completion gateが再照合する。
- [ ] **AC-19** failure、DENY、ESCALATE、timeout、tool limitが§17のState/Event/Evidenceになる。

### Verification / Scope

- [ ] **AC-20** Scenario A–Jが独立したintegration testsとして通る。
- [ ] **AC-21** v0.2 Doctrine/state/persistence testsが全て回帰しない。
- [ ] **AC-22** `corepack pnpm run check`、built CLI smoke、`git diff --check`が通る。
- [ ] **AC-23** package public exportからraw broker execution permitとstate transition permitへ到達できない。
- [ ] **AC-24** `.agents/doctrine/decision-rights.md`をv0.3実装都合で変更していない。
- [ ] **AC-25** Non-goalのInfrastructureまたは自由度を追加していない。

---

## 21. Explicit Non-goals

- Multiple Workers
- Parallel execution
- Dynamic Agent creation
- Production deployment
- Unrestricted shell
- Unrestricted network access
- Generic Policy DSL
- Container orchestration platform
- Distributed Runtime
- Human Approval lifecycleの完全実装
- Crash recoveryの完全実装
- hostile test codeを封じ込めるOS sandbox
- package installation / dependency download
- multi-file atomic transaction
- binary file patch、git commit/branch/merge、remote操作
- generic secret scanner / DLP

---

## 22. 実装で避ける設計

- ToolBroker内で認可するだけにして、Runtime pipelineを迂回可能にする。
- `ResourceScope`の文字列prefixだけでpathを許可する。
- `repo.patch`を`git apply`やshell文字列へそのまま渡す。
- test command名だけallowlistにし、Agent指定argumentを連結する。
- stdoutに`PASS`が含まれるだけでtest成功とする。
- Worker outputへEvidenceを埋め込ませ、それをDB recordとして信頼する。
- Evaluator PASSを直接Task statusへ代入する。
- Evidence保存前にTaskを完了する。
- 安全のため全readまでHuman approvalへEscalateし、bounded autonomyを失う。
- v0.3のためにDoctrine Markdown、汎用Policy DSL、distributed executionを追加する。

最終原則は変わらない。

```text
Agent decides.
Runtime controls.
Evidence proves.
```
