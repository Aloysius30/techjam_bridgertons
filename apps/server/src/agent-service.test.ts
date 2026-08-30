import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
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
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder", ownerId: "user-a" });
    expect(service.listAgents("user-a")).toHaveLength(1);
    expect(
      (await service.updateAgent(agent.id, "user-a", { description: "Builds apps" }))
        .description,
    ).toBe("Builds apps");
    expect((await service.stopAgent(agent.id, "user-a")).status).toBe("stopped");
    expect((await service.startAgent(agent.id, "user-a")).status).toBe("ready");
    await service.deleteAgent(agent.id, "user-a");
    expect(service.listAgents("user-a")).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder", ownerId: "user-a" });
    const { run } = await service.sendMessage(agent.id, "user-a", "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id, "user-a");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id, "user-a").codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent", ownerId: "user-a" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "user-a", "first"),
      service.sendMessage(agent.id, "user-a", "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id, "user-a")).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy", ownerId: "user-a" });
    const { run } = await service.sendMessage(agent.id, "user-a", "first");

    await expect(service.startAgent(agent.id, "user-a")).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(service.sendMessage(agent.id, "user-a", "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});

describe("Ownership isolation", () => {
  it("lets an owner access their own Agent but blocks other users with 403", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Owned by A", ownerId: "user-a" });

    expect(service.getAgent(agent.id, "user-a").id).toBe(agent.id);

    expect(() => service.getAgent(agent.id, "user-b")).toThrowError(
      expect.objectContaining({ statusCode: 403 }),
    );
    await expect(
      service.updateAgent(agent.id, "user-b", { description: "hijacked" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.startAgent(agent.id, "user-b")).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(service.stopAgent(agent.id, "user-b")).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(() => service.getMessages(agent.id, "user-b")).toThrowError(
      expect.objectContaining({ statusCode: 403 }),
    );
    expect(() => service.getRuns(agent.id, "user-b")).toThrowError(
      expect.objectContaining({ statusCode: 403 }),
    );
    await expect(service.sendMessage(agent.id, "user-b", "hi")).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(service.deleteAgent(agent.id, "user-b")).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("only lists a user's own Agents", async () => {
    const service = await makeService();
    await service.createAgent({ name: "A's agent", ownerId: "user-a" });
    await service.createAgent({ name: "B's agent", ownerId: "user-b" });

    const forA = service.listAgents("user-a");
    const forB = service.listAgents("user-b");

    expect(forA.map((agent) => agent.name)).toEqual(["A's agent"]);
    expect(forB.map((agent) => agent.name)).toEqual(["B's agent"]);
  });
});
