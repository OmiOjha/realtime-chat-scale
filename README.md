# Gather — real-time chat

A TypeScript npm-workspaces monorepo for a MongoDB and Redis-backed chat API, Socket.IO realtime service, and accessible React web client.

## Features

- Email/password registration and login with bcrypt hashes and signed JWTs.
- Membership-protected REST chat APIs and Socket.IO handshake/room authorization.
- Direct and group conversations, message history with sequence cursors, and realtime sends.
- Redis-backed per-chat sequence allocation, duplicate-send handling, and cache-loss recovery from persisted messages.
- Delivered/read receipts, missed-message synchronization on reconnect, online presence, and typing indicators.
- Redis Socket.IO adapter and Redis-backed API/socket rate limits.
- Docker Compose for local services, an Nginx gateway, a GitHub Actions CI pipeline, and an optional SSH-based container deployment workflow.

## Local development

Requirements: Node.js 22+, MongoDB 7+, and Redis 7+. From the repository root:

```sh
npm ci
cp .env.example .env
```

Set `JWT_SECRET` to a private random value of at least 32 characters. Start MongoDB and Redis, then run:

```sh
docker compose up -d mongo redis
npm run dev
```

The API is available at `http://localhost:4000`, and Vite serves the client at `http://localhost:5173`.

### Run locally with Docker Compose

With Docker Engine and the Compose plugin installed:

```sh
cp .env.example .env
# Replace JWT_SECRET with a private random value.
docker compose up --build
```

Open `http://localhost:8080`. Compose starts MongoDB, Redis, the API, and the Nginx-served web client. Persistent database volumes are created for MongoDB and Redis.

## Tests, type checks, and builds

The integration suite starts a temporary MongoDB and a local `redis-server`; install Redis locally before running it.

```sh
npm test
npm run typecheck
npm run build
```

The test suite covers authentication, REST membership checks, direct/group chat creation, cursor paging and recovery, Redis sequence repair, duplicate sends, Socket.IO JWT rejection, cross-instance broadcasts, message receipts, typing, and basic UI auth/loading states.

## Light load smoke test

The checked-in Artillery profile issues a low-rate request to the Nginx `/health` route. It is an operational smoke test, not a capacity benchmark:

```sh
npm exec -- artillery run tests/load/smoke.yml --target http://localhost:8080
```

Measure and tune against the intended deployment environment before making throughput or capacity claims.

## Production deployment

The optional `Deploy container stack` GitHub Actions workflow builds and publishes API/web images to GHCR, then copies `docker-compose.prod.yml` to a configured Linux Docker host over SSH. It expects MongoDB and Redis endpoints that are reachable from that host; configure managed services or another production-grade data setup before deploying.

1. Provision a Linux host with Docker Compose, an external MongoDB deployment, and Redis. Create `/opt/realtime-chat` and make it writable by the SSH deployment user.
2. Create `/opt/realtime-chat/.env` on the host using `.env.production.example` as a guide. Use a unique JWT secret, production database/Redis URLs, and the browser origin, such as `https://chat.example.com`.
3. Add these repository Actions secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` (verified host-key entry), `GHCR_USERNAME`, and a read-only `GHCR_READ_TOKEN`.
4. Merge the deployment workflow onto the repository's default branch, then run **Actions → Deploy container stack → Run workflow**. The host needs outbound access to GHCR and inbound web access.
5. Terminate HTTPS at a managed load balancer or a separately configured TLS reverse proxy and forward traffic to the Compose web port. The included Nginx config handles the SPA, API paths, and Socket.IO WebSocket upgrade; it does not issue TLS certificates itself.

This repository does not contain production credentials and this workspace has no Docker Engine or deployment host configured, so no live service has been deployed from this change. The workflow and container stack are ready once the host, managed data services, TLS endpoint, and repository secrets are provided.

## Operational boundaries

Message sequence values can contain gaps when a process crashes after Redis allocates a value but before MongoDB persists the message; cursors remain ordered and the Redis floor is repaired from persisted history. The MongoDB uniqueness constraints protect client-message IDs and per-chat sequence values. Redis adapter/presence/rate-limit data are ephemeral; chat and message history remain in MongoDB. The Compose deployment uses a single API container by default, though the Socket.IO Redis adapter supports multiple API instances when placed behind a WebSocket-capable load balancer.
