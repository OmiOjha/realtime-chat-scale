# Real-time Chat

Phase 1 is a TypeScript npm-workspaces monorepo with a MongoDB-backed Express API, Socket.IO messaging, and a React/Vite chat client.

## Local development

Requirements: Node.js 20+ and MongoDB 6+. From the repository root:

```sh
npm install
cp .env.example .env
```

Set `JWT_SECRET` in `.env` to a private random value. Start MongoDB locally, then run:

```sh
npm run dev
```

The API listens on `http://localhost:4000` and the web app on `http://localhost:5173`. Accounts can be registered from the login screen. Authenticated `POST /chats` accepts `{ "type": "direct" | "group", "members": ["<registered-user-id>"], "title": "optional" }`; the signed-in user is added automatically, and all chat and message reads are restricted to members.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

## Phase 1 boundaries

Messages receive a per-chat sequence using a MongoDB atomic counter so cursor pagination and the initial chat workflow work without Redis. The counter and message insert are not a distributed transaction. Client message IDs are stored, but are not deduplicated. Delivery/read arrays are model fields only; no state transitions, reconnect synchronization, scaling, presence, typing, rate limiting, or load-test claims are included in this phase.
