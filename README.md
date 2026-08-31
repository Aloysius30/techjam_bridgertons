# Agent Ownership Shield — Multi-Layer Identity & Isolation Middleware

Built for TikTok TechJam 2026, Track 1 (Agent Launchpad: Design and Build Lightweight Agent Middleware).

## The problem

The starter kit is a single-user proof of concept — any authenticated caller can view,
edit, start, stop, delete, or message *any* Agent, and every Agent runs in the same
kind of environment with no real concept of ownership. In an actual multi-user
platform that's a real problem: one user's coding agent, workspace, and protected
data would be fully exposed to everyone else — and even a misdirected Agent could go
looking for another user's files.

## What we built

We enforce ownership at three separate layers instead of just one, so a bypass or
mistake at one layer doesn't expose the whole system:

1. **API layer** — the backend rejects requests from anyone who doesn't own the Agent
   they're trying to touch, with a real `403 Forbidden`.
2. **Infrastructure layer** — each Agent's Docker container only has its owner's data
   mounted in. Even if something went wrong with the Agent's own reasoning, there's
   nothing belonging to another user physically present for it to find.
3. **Observability layer** — every run and every denied access attempt gets logged.

### Layer 1 — API-level ownership isolation

- `Agent.ownerId` — every Agent has an owner, set at creation and required, not
  optional.
- A single enforcement point — `AgentService.getAgent(id, userId)` checks ownership
  once: 404 if the Agent doesn't exist, 403 if `agent.ownerId !== userId`. Every other
  service method (update, delete, start, stop, get messages, get runs, send message)
  calls through this first, instead of repeating the check in every route.
- Methods that re-fetch the Agent inside an atomic `store.mutate()` call re-check
  ownership inside that mutation too — closes a small gap between the initial check
  and the mutation actually running.
- A simple `x-user-id` header identifies the caller. This is intentionally basic
  (real auth was out of scope for a 3-day hackathon, and the problem statement says
  a small mock identity model is fine), but the enforcement around it is real and
  happens server-side.
- `GET /api/agents` filters by owner in the service layer, so one user's list never
  contains another user's agents in the response.

### Layer 2 — Container-level filesystem isolation

- `container-codex-runner.ts` builds a `--mount` argument for every Run that's scoped
  to the Agent's owner — something like
  `type=bind,src=<dataDirectory>/protected-<ownerId>,dst=/protected-data,readonly`.
  User A's container never has User B's directory mounted in, and the other way
  around. This isn't a permission check — the other user's data literally isn't there.
- The Agent is also told its own owner ID and instructed not to reveal secret
  contents, even to its own owner. On its own that instruction is soft — a
  determined user could try to talk the model out of it. What actually makes this
  hold is the Docker mount underneath it: even if someone got the Agent to try
  something it shouldn't, there's no other user's file in the container to find.
- We tested this live: as User A, the Agent can confirm its own
  `/protected-data/secret.txt` exists (without printing it), but reports it doesn't
  exist and refuses to search when asked about User B's — and the same the other way
  around.

### Layer 3 — Audit trail

- `audit-logger.ts` writes an append-only log of:
  - `RUN_STARTED` — Agent ID, owner, prompt
  - `RUN_COMPLETED` — Agent ID, owner, run ID, tokens used, duration
  - `RUN_FAILED` — Agent ID, owner, error detail
  - `ACCESS_DENIED` — fires automatically from inside `getAgent` whenever someone
    tries to access an Agent they don't own
- Written to `audit.log` in the app's data directory, readable via `GET /api/audit`,
  and viewable in the UI through the "Show Audit Log" panel.

## Demo script

1. Create an Agent as User A, send it a real task — it runs, and a `RUN_STARTED` /
   `RUN_COMPLETED` pair shows up in the audit log.
2. Ask it to check its own protected file (e.g. "does `/protected-data/secret.txt`
   exist? confirm access, don't reveal the contents") — it confirms the file exists
   and is readable without printing it.
3. Ask it to look for User B's data — it refuses, correctly identifying itself as
   sandboxed to its own owner's data.
4. Switch to User B — the agent list is now empty.
5. Try direct access as User B: `curl -H "x-user-id: user-b"
   http://localhost:3000/api/agents/<agent-id>` — returns `403`, and an
   `ACCESS_DENIED` entry shows up in the audit log.
6. Switch back to User A — the agent is still there and still works.

## Setup

Requirements: Node.js 22+, npm 10+, one container engine (Docker/Colima/Podman), a
BytePlus/Volcengine ModelArk API key and Responses-compatible endpoint ID.

```bash
git clone https://github.com/Aloysius30/techjam_bridgertons.git
cd techjam_bridgertons
RUNTIME_PROVIDER=container \
ARK_API_KEY=your-api-key \
ARK_MODEL=your-endpoint-id \
ARK_BASE_URL=https://ark.ap-southeast.bytepluses.com/api/v3 \
npm run poc
```

**Note:** `RUNTIME_PROVIDER=container` is required for the filesystem isolation
layer to actually take effect. The starter kit defaults to `local-process`, which
uses a different runner that skips the per-owner Docker mount entirely. Without this
flag, ownership isolation and audit logging still work fine, but the container-level
isolation won't.

Open `http://localhost:3000`, pick a user from the sidebar, create an Agent, and try
the demo script above.

## Automated tests

Ownership isolation is covered at both layers:

- **Service layer** (`agent-service.test.ts`) — owner access succeeds, every
  id-taking method throws `403` for a non-owner, and `listAgents` filters correctly.
- **HTTP layer** (`app.test.ts`) — `401` with no `x-user-id` header, `200` for the
  owner, `403` for anyone else, and the list endpoint excludes other users' agents.

```bash
npm run check
```

17/17 tests passing — typecheck, tests, and build all clean.

## Known limitations

- `GET /api/runs/:id` isn't ownership-checked. Run IDs are UUIDs and not guessable,
  so it's not an open door, but a stricter version would trace back to the parent
  Agent and check ownership there too.
- The `x-user-id` header isn't cryptographically verified — a malicious client could
  claim to be anyone. This was an intentional scope decision for a hackathon demo,
  not something we'd ship as-is.
- The "who am I" instruction given to the Agent is soft on its own — it's one layer
  of a defense-in-depth story, not a standalone guarantee. The Docker mount is the
  layer that actually holds regardless of what the Agent is told or talked into.
- Given more time: real session-based auth, revocable per-agent credentials,
  ownership checks on `GET /api/runs/:id`, and a proper filterable UI for the audit
  log instead of a flat list.

## Team

**Bridgertons**

- imbryan23
- Aloysius30
- nuj0n
- pjunhaooo

## Architecture

See the diagram in this repo. Every request carries an `x-user-id` header. The
Fastify hook checks it's present, `AgentService.getAgent(id, userId)` is the
API-layer enforcement point, and when a Run actually executes,
`container-codex-runner.ts` scopes the container's filesystem to that owner's data
only. Every run and every denied access attempt gets recorded by `audit-logger.ts`.