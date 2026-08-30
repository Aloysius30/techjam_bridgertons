import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: null,
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeOwnershipApp() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-app-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const ownedService = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    new FakeRunner(),
  );
  await ownedService.initialize();
  return createApp(config, ownedService);
}

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token", "x-user-id": "user-a" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", "x-user-id": "user-a" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", "x-user-id": "user-a" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});

describe("Ownership isolation", () => {
  it("requires an x-user-id header on /api/agents routes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const response = await app.inject({ method: "GET", url: "/api/agents" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("lets User A access their own Agent and blocks User B with 403", async () => {
    const app = await makeOwnershipApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", "x-user-id": "user-a" },
      payload: JSON.stringify({ name: "A's agent" }),
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().agent.id as string;

    const asOwner = await app.inject({
      method: "GET",
      url: "/api/agents/" + agentId,
      headers: { "x-user-id": "user-a" },
    });
    expect(asOwner.statusCode).toBe(200);

    const asOther = await app.inject({
      method: "GET",
      url: "/api/agents/" + agentId,
      headers: { "x-user-id": "user-b" },
    });
    expect(asOther.statusCode).toBe(403);

    await app.close();
  });

  it("excludes another user's Agents from the list", async () => {
    const app = await makeOwnershipApp();

    await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", "x-user-id": "user-a" },
      payload: JSON.stringify({ name: "A's agent" }),
    });

    const listForB = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { "x-user-id": "user-b" },
    });
    expect(listForB.statusCode).toBe(200);
    expect(listForB.json().agents).toEqual([]);

    const listForA = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { "x-user-id": "user-a" },
    });
    expect(listForA.json().agents).toHaveLength(1);

    await app.close();
  });
});
