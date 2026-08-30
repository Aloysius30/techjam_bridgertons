# Agent Launchpad — Identity & Ownership Isolation

Built for TikTok TechJam 2026, Track 1 (Agent Launchpad: Design and Build Lightweight Agent Middleware).

## The problem

The starter kit ships as a single-user proof of concept: any authenticated caller can view,
edit, start, stop, delete, or message *any* Agent. There is no concept of who owns what.
In a real multi-user Agent platform, this is a critical gap — one user's automated
coding agent, workspace files, and conversation history would be fully exposed to
every other user of the platform.

## Our solution

We added **backend-enforced ownership isolation**: every Agent now belongs to a specific
user, and the server rejects any request from a user who doesn't own the Agent they're
trying to access — with a real `403 Forbidden`, not just a hidden UI element.

### Design

- **`Agent.ownerId`** — every Agent now carries an owner, set at creation time from the
  requesting user's identity. This is a required field, not optional, so there's no
  "ownerless" agent path going forward.
- **A single enforcement chokepoint** — `AgentService.getAgent(id, userId)` is the one
  place ownership is checked: it 404s if the Agent doesn't exist, then 403s if
  `agent.ownerId !== userId`. Every other service method (update, delete, start, stop,
  get messages, get runs, send message) calls through this method first, so the check
  is centralized rather than duplicated across routes.
- **Re-validation inside mutations** — methods that later re-fetch the Agent inside an
  atomic `store.mutate()` call (update, send message, set status) re-check ownership
  *inside* that mutation too. This isn't redundant — it closes a theoretical gap between
  the initial check and the mutation actually running.
- **Mock user identity** — since building real authentication was out of scope for a
  3-day hackathon, we use a lightweight `x-user-id` header to identify the caller. This
  is intentionally simple (per the problem statement's guidance that "a small mock
  identity model is acceptable"), but the *enforcement* around it is real and backend-side.
- **Server-side list filtering** — `GET /api/agents` filters by `ownerId` in the service
  layer, so a user's agent list never contains another user's agents in the response —
  this isn't just hidden by the frontend, it's never sent to the client at all.

### Where the boundary lives

The Fastify `onRequest` hook extracts `x-user-id` and attaches it to the request,
returning `401` if missing on any `/api/agents*` route. From there, every route handler
passes the userId into the corresponding `AgentService` method, which performs the
actual 403 check. See the architecture diagram in this repo for the full request flow
and trust boundary.

## Demo script

1. **Create an Agent as User A** (select "User A" in the sidebar switcher, click Create
   Agent, give it a task in the Playground) — it runs successfully.
2. **Switch to User B** — the agent list is now empty; User A's agent doesn't appear.
3. **Attempt direct access as User B** (e.g. via `curl -H "x-user-id: user-b"
   http://localhost:3000/api/agents/<agent-id>`) — returns `403 Forbidden`.
4. **Switch back to User A** — the agent is still there and fully functional.

## Setup

Requirements: Node.js 22+, npm 10+, one container engine (Docker/Colima/Podman), a
BytePlus/Volcengine ModelArk API key and Responses-compatible endpoint ID.

```bash
git clone https://github.com/Aloysius30/techjam_bridgertons.git
cd techjam_bridgertons
ARK_API_KEY=your-api-key \
ARK_MODEL=your-endpoint-id \
ARK_BASE_URL=https://ark.ap-southeast.bytepluses.com/api/v3 \
npm run poc
```

Open `http://localhost:3000`. Select a user (User A / User B) from the sidebar, create
an Agent, and try the demo script above.

## Automated tests

We added an "Ownership isolation" test suite at both layers:

- **Service layer** (`agent-service.test.ts`) — owner access succeeds; every
  id-taking method (`getAgent`, `updateAgent`, `deleteAgent`, `startAgent`, `stopAgent`,
  `getMessages`, `getRuns`, `sendMessage`) throws `403` for a non-owner; `listAgents`
  correctly filters by owner.
- **HTTP layer** (`app.test.ts`) — end-to-end route tests confirming `401` with no
  `x-user-id` header, `200` for the owner, `403` for a different user, and that the
  list endpoint excludes other users' agents.

Run the full suite:

```bash
npm run check
```

(17/17 tests passing as of this submission — typecheck, tests, and production build
all clean.)

## Known limitations

- **`GET /api/runs/:id`** (fetching a single run by its own run ID, used for polling)
  is *not* ownership-checked. Run IDs are UUIDs and not guessable, so this isn't an
  open door, but a stricter implementation would resolve the run's parent Agent and
  check ownership there too.
- **Mock identity, not real auth** — the `x-user-id` header is not cryptographically
  verified; a malicious client could claim to be any user. This is an intentional,
  documented scope decision for a hackathon demo, not a production-ready identity system.
- **Given more time**, we would add: real session-based authentication, action
  attribution/audit logging, and revocable per-agent credentials.

## Team

**Bridgertons**

- imbryan23
- Aloysius30
- (2 more — TBD)

## Architecture

See the architecture diagram in this repo — shows the trust boundary (browser → API),
the enforcement chokepoint (`AgentService.getAgent`), and the denial path (403).