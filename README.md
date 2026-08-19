# Command & Control Runtime — Prototype v0.1

AI Agent を判断主体、Runtime を状態・権限・統制の唯一の所有者として分離した、最小の Command & Control（C2）実行基盤です。

```text
Goal → Commander → Lead → Worker → Evaluator
                                  │
                     PASS / retry / replan / escalate / fail
                                  │
                         Runtime state transition
                                  │
                       SQLite state + history
```

この実装は [Implementation Brief](./Command%20%26%20Control%20Runtime%20%E2%80%94%20Prototype%20v0.1%20Implementation%20Brief.md) の Prototype v0.1 に限定しています。複数Worker、並列実行、Message Bus、長期Memory、Web UIなどは含みません。`.agents/doctrine/` は拡張点だけを用意し、Doctrineの内容は定義していません。

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

- `src/domain/`: Domain ModelとZod schema。Agent proposalとRuntime-owned entityを分離
- `src/runtime/`: C2 loop、Mission/Task状態機械、retry/replan/escalation
- `src/agents/`: Agent interfaceと決定論的Mock Agents
- `src/llm/`: provider非依存のStructured LLM interfaceと4役のadapter
- `src/storage/sqlite/`: 必須6 table、snapshot、atomic transition、append-only event log
- `src/cli/`: 最小実行・参照interface
- `tests/`: unit / integration tests
- `evals/prototype-v0.1-acceptance.md`: 要件と自動検証証拠の対応表

## 状態所有権と検証境界

AgentはMission proposal、Task plan、Task result/report、Evaluationを返します。すべての戻り値はRuntime境界で再度Zod validationを通ります。Agentの出力には永続ID、timestamp、Mission/Task statusを含められず、実際の状態遷移は明示的な状態機械とSQLite transactionだけが行います。

Workerの`success` reportだけでTaskは完了しません。Evaluatorが`pass/complete`を返し、それをRuntimeが検証した後に限って`completed`へ遷移します。

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
