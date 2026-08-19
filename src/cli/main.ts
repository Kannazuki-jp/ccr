#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createMockAgents,
  type MockScenario,
} from "../agents/mock-agents.js";
import {
  CommandControlRuntime,
  type MissionRunResult,
} from "../runtime/runtime.js";
import { SqliteStore } from "../storage/sqlite/index.js";

interface CliOptions {
  readonly operands: string[];
  readonly database: string;
  readonly scenario: MockScenario;
  readonly json: boolean;
}

const SCENARIOS = new Set<MockScenario>([
  "happy",
  "retry",
  "replan",
  "escalation",
  "terminal-fail",
]);

export async function runCli(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArguments(argv);
  } catch (error) {
    printError(error);
    printUsage();
    return 1;
  }

  const [command, entity, ...rest] = options.operands;
  if (command === undefined || command === "help" || command === "--help") {
    printUsage();
    return 0;
  }
  if (entity !== "mission") {
    process.stderr.write("Expected the entity name 'mission'.\n");
    printUsage();
    return 1;
  }

  const store = new SqliteStore(options.database);
  try {
    const agents = createMockAgents({ scenario: options.scenario });
    const runtime = new CommandControlRuntime(store, agents, {
      agentImplementations: {
        commander: "mock",
        lead: "mock",
        worker: "mock",
        evaluator: "mock",
      },
    });

    if (command === "run") {
      const goal = rest.join(" ").trim();
      if (goal.length === 0) {
        throw new TypeError("A non-empty goal is required");
      }
      const result = await runtime.run({ goal });
      printResult(result, options.json);
      return 0;
    }

    if (command === "show") {
      const missionId = rest[0];
      if (missionId === undefined || rest.length !== 1) {
        throw new TypeError("show mission requires exactly one Mission ID");
      }
      const result = runtime.observeMission(missionId);
      if (result === undefined) {
        process.stderr.write(`Mission not found: ${missionId}\n`);
        return 1;
      }
      printResult(result, options.json);
      return 0;
    }

    process.stderr.write(`Unknown command: ${command}\n`);
    printUsage();
    return 1;
  } catch (error) {
    printError(error);
    return 1;
  } finally {
    store.close();
  }
}

function parseArguments(argv: string[]): CliOptions {
  const operands: string[] = [];
  let database = resolve(process.cwd(), "c2-runtime.sqlite");
  let scenario: MockScenario = "happy";
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help") {
      operands.push("help");
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--db") {
      const value = argv[index + 1];
      if (value === undefined) throw new TypeError("--db requires a path");
      database = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--scenario") {
      const value = argv[index + 1];
      if (value === undefined || !SCENARIOS.has(value as MockScenario)) {
        throw new TypeError(
          `--scenario must be one of: ${[...SCENARIOS].join(", ")}`,
        );
      }
      scenario = value as MockScenario;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--") === true) {
      throw new TypeError(`Unknown option: ${argument}`);
    }
    if (argument !== undefined) operands.push(argument);
  }

  return { operands, database, scenario, json };
}

function printResult(result: MissionRunResult, json: boolean): void {
  const recentEvent = result.events.at(-1);
  const view = {
    mission: {
      id: result.mission.id,
      goal: result.mission.goal,
    },
    status: result.status,
    currentTask:
      result.currentTask === undefined
        ? null
        : {
            id: result.currentTask.id,
            objective: result.currentTask.objective,
            status: result.currentTask.status,
          },
    recentEvent:
      recentEvent === undefined
        ? null
        : {
            type: recentEvent.type,
            createdAt: recentEvent.createdAt.toISOString(),
          },
    escalation: result.escalation ?? null,
    finalResult: result.finalResult ?? null,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Mission: ${view.mission.id} — ${view.mission.goal}`,
      `Status: ${view.status}`,
      `Current Task: ${
        view.currentTask === null
          ? "none"
          : `${view.currentTask.id} — ${view.currentTask.objective} (${view.currentTask.status})`
      }`,
      `Recent Event: ${
        view.recentEvent === null
          ? "none"
          : `${view.recentEvent.type} @ ${view.recentEvent.createdAt}`
      }`,
      `Escalation: ${
        view.escalation === null
          ? "none"
          : `required — ${view.escalation.reason}`
      }`,
      `Final Result: ${view.finalResult ?? "pending"}`,
    ].join("\n") + "\n",
  );
}

function printUsage(): void {
  process.stdout.write(`Command & Control Runtime v0.1

Usage:
  corepack pnpm start -- run mission "<goal>" [--db <path>] [--scenario <name>] [--json]
  corepack pnpm start -- show mission <mission-id> [--db <path>] [--json]

Mock scenarios: happy, retry, replan, escalation, terminal-fail
`);
}

function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
}

const entryUrl = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryUrl === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
