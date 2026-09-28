import { createServer, Server as HttpServer } from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import { once } from "node:events";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import Redis from "ioredis";
import { nextMessageSequence } from "../src/services/messageSequence";
import { isWithinRateLimit } from "../src/services/rateLimit";
import { isUserOnline, refreshPresence, removePresence } from "../src/services/presence";
import { io as createClient, Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { createApp } from "../src/app";
import { attachSocketServer, closeSocketRedisClients } from "../src/socket";

jest.setTimeout(60000);

describe("Chat API and Socket.IO", () => {
  let mongo: MongoMemoryServer;
  let redisProcess: ChildProcess;
  let redis: Redis;
  let httpServer: HttpServer;
  let serverAddress: string;
  let secondHttpServer: HttpServer;
  let secondServerAddress: string;
  let socketServer: Awaited<ReturnType<typeof attachSocketServer>> | undefined;
  let secondSocketServer: Awaited<ReturnType<typeof attachSocketServer>> | undefined;
  let clients: ClientSocket[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-characters";
    process.env.CLIENT_ORIGIN = "http://localhost:5173";
    const portProbe = createServer();
    portProbe.listen(0);
    await once(portProbe, "listening");
    const address = portProbe.address();
    if (!address || typeof address === "string") throw new Error("Could not choose a Redis port");
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    const redisPort = address.port;
    process.env.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
    redisProcess = spawn("redis-server", [
      "--port", String(redisPort), "--save", "", "--appendonly", "no"
    ], { stdio: "ignore" });
    redisProcess.once("error", (error) => {
      throw new Error(`Could not start test Redis: ${error.message}`);
    });
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, retryStrategy: (attempt) => Math.min(attempt * 50, 500) });
    await redis.ping();
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    httpServer = createServer(createApp(redis));
    socketServer = await attachSocketServer(httpServer, redis);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const serverLocation = httpServer.address();
    if (!serverLocation || typeof serverLocation === "string") throw new Error("Test server did not start");
    serverAddress = `http://127.0.0.1:${serverLocation.port}`;
    secondHttpServer = createServer(createApp(redis));
    secondSocketServer = await attachSocketServer(secondHttpServer, redis);
    await new Promise<void>((resolve) => secondHttpServer.listen(0, resolve));
    const secondLocation = secondHttpServer.address();
    if (!secondLocation || typeof secondLocation === "string") throw new Error("Second test server did not start");
    secondServerAddress = `http://127.0.0.1:${secondLocation.port}`;
  });

  afterEach(() => {
    clients.forEach((client) => client.disconnect());
    clients = [];
  });

  afterAll(async () => {
    if (socketServer) await closeSocketRedisClients(socketServer);
    if (secondSocketServer) await closeSocketRedisClients(secondSocketServer);
    if (redis) await redis.quit();
    if (redisProcess?.exitCode === null) redisProcess.kill("SIGTERM");
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  async function register(email: string, displayName: string) {
    return request(httpServer)
      .post("/auth/register")
      .send({ email, displayName, password: "secure-passphrase" });
  }

  it("rebuilds a Redis sequence floor from persisted messages after cache loss", async () => {
    const chatId = new mongoose.Types.ObjectId().toString();
    await redis.set(`chat:${chatId}:sequence`, "2");
    expect(await nextMessageSequence(redis, chatId, 8)).toBe(9);
  });

  it("keeps multi-socket presence correct and enforces fixed-window limits atomically", async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    expect(await refreshPresence(redis, userId, "socket-a")).toBe(1);
    expect(await refreshPresence(redis, userId, "socket-b")).toBe(2);
    expect(await removePresence(redis, userId, "socket-a")).toBe(1);
    expect(await isUserOnline(redis, userId)).toBe(true);
    expect(await removePresence(redis, userId, "socket-b")).toBe(0);
    expect(await isUserOnline(redis, userId)).toBe(false);

    const limitKey = `limit:test:${userId}`;
    expect(await isWithinRateLimit(redis, limitKey, 2, 60_000)).toBe(true);
    expect(await isWithinRateLimit(redis, limitKey, 2, 60_000)).toBe(true);
    expect(await isWithinRateLimit(redis, limitKey, 2, 60_000)).toBe(false);
  });

  function connect(token: string, address = serverAddress) {
    const client = createClient(address, {
      auth: { token },
      forceNew: true,
      reconnection: false
    });
    clients.push(client);
    return client;
  }

  function waitForConnect(client: ClientSocket) {
    return new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });
  }

  function waitForConnectError(client: ClientSocket) {
    return new Promise<Error>((resolve, reject) => {
      client.once("connect_error", resolve);
      client.once("connect", () => reject(new Error("Expected connection to be rejected")));
    });
  }

  function emitWithAck(client: ClientSocket, event: string, payload: unknown) {
    return new Promise<{ ok: boolean; error?: string; message?: Record<string, unknown> }>((resolve) => {
      client.emit(event, payload, resolve);
    });
  }

  it("registers and logs in, authorizes chat history, paginates, and sends messages over sockets", async () => {
    const first = await register("first@example.test", "First User");
    const second = await register("second@example.test", "Second User");
    const outsider = await register("outsider@example.test", "Outsider");

    expect(first.status).toBe(201);
    expect(first.body.user).toMatchObject({ email: "first@example.test", displayName: "First User" });
    expect(first.body.user.passwordHash).toBeUndefined();
    expect((await request(httpServer).post("/auth/login").send({
      email: "first@example.test",
      password: "secure-passphrase"
    })).status).toBe(200);
    expect((await request(httpServer).post("/auth/login").send({
      email: "first@example.test",
      password: "wrong-password"
    })).status).toBe(401);
    expect((await request(httpServer).get("/chats")).status).toBe(401);

    const firstToken = first.body.token as string;
    const secondToken = second.body.token as string;
    const outsiderToken = outsider.body.token as string;
    const created = await request(httpServer)
      .post("/chats")
      .set("Authorization", `Bearer ${firstToken}`)
      .send({ type: "direct", members: [second.body.user.email] });
    expect(created.status).toBe(201);
    const chatId = created.body.chat._id as string;
    const group = await request(httpServer)
      .post("/chats")
      .set("Authorization", `Bearer ${firstToken}`)
      .send({ type: "group", title: "Friends", members: [second.body.user.id, outsider.body.user.email] });
    expect(group.status).toBe(201);
    expect(group.body.chat.members).toHaveLength(3);

    expect((await request(httpServer)
      .get(`/chats/${chatId}/messages`)
      .set("Authorization", `Bearer ${outsiderToken}`)).status).toBe(404);
    expect((await request(httpServer)
      .get("/chats")
      .set("Authorization", `Bearer ${secondToken}`)).body.chats).toHaveLength(2);

    const sender = connect(firstToken);
    const recipient = connect(secondToken, secondServerAddress);
    await Promise.all([waitForConnect(sender), waitForConnect(recipient)]);
    const invalidClient = connect("not-a-valid-token");
    await expect(waitForConnectError(invalidClient)).resolves.toThrow("Invalid or expired token");

    expect(await emitWithAck(recipient, "chat:join", { chatId, afterSeq: 0 })).toMatchObject({ ok: true });
    expect(await emitWithAck(sender, "chat:join", { chatId, afterSeq: 0 })).toMatchObject({ ok: true });
    const unauthorized = connect(outsiderToken);
    await waitForConnect(unauthorized);
    expect(await emitWithAck(unauthorized, "chat:join", { chatId, afterSeq: 0 })).toMatchObject({ ok: false });
    expect(await emitWithAck(unauthorized, "message:send", {
      chatId,
      clientMsgId: "unauthorized",
      body: "Not allowed"
    })).toMatchObject({ ok: false });

    const typingEvent = new Promise<{ chatId: string; userId: string }>((resolve) => {
      recipient.once("typing:start", resolve);
    });
    sender.emit("typing:start", chatId);
    expect(await typingEvent).toMatchObject({ chatId, userId: first.body.user.id });

    const incomingMessage = new Promise<Record<string, unknown>>((resolve) => {
      recipient.once("message:new", resolve);
    });
    const sent = await emitWithAck(sender, "message:send", {
      chatId,
      clientMsgId: "client-1",
      body: "Hello there"
    });
    expect(sent).toMatchObject({ ok: true, message: { body: "Hello there", seq: 1, senderId: first.body.user.id } });
    expect(await incomingMessage).toMatchObject({ body: "Hello there", seq: 1 });
    expect(await emitWithAck(sender, "message:send", {
      chatId,
      clientMsgId: "client-1",
      body: "Hello there"
    })).toMatchObject({ ok: true, message: { seq: 1 } });
    expect(await emitWithAck(sender, "message:send", {
      chatId,
      clientMsgId: "client-1",
      body: "Changed message body"
    })).toMatchObject({ ok: false });
    expect(await emitWithAck(recipient, "message:delivered", { chatId, seq: 1 })).toMatchObject({ ok: true });
    expect(await emitWithAck(recipient, "message:read", { chatId, seq: 1 })).toMatchObject({ ok: true });

    const secondSent = await emitWithAck(sender, "message:send", {
      chatId,
      clientMsgId: "client-2",
      body: "A second note"
    });
    expect(secondSent).toMatchObject({ ok: true, message: { body: "A second note", seq: 2 } });

    const restored = await emitWithAck(recipient, "chat:join", { chatId, afterSeq: 1 });
    expect(restored).toMatchObject({ ok: true, messages: [{ body: "A second note", seq: 2 }] });

    const paged = await request(httpServer)
      .get(`/chats/${chatId}/messages?beforeSeq=2&limit=1`)
      .set("Authorization", `Bearer ${firstToken}`);
    expect(paged.status).toBe(200);
    expect(paged.body.messages).toHaveLength(1);
    expect(paged.body.messages[0].clientMsgId).toBe("client-1");
    const recovered = await request(httpServer)
      .get(`/chats/${chatId}/messages?afterSeq=1&limit=10`)
      .set("Authorization", `Bearer ${firstToken}`);
    expect(recovered.body.messages).toHaveLength(1);
    expect(recovered.body.messages[0].body).toBe("A second note");
    expect(paged.body.messages[0].deliveredTo).toContain(second.body.user.id);
    expect(paged.body.messages[0].readBy).toContain(second.body.user.id);
    expect((await request(httpServer)
      .get(`/chats/${chatId}/messages?limit=0`)
      .set("Authorization", `Bearer ${firstToken}`)).status).toBe(400);
  });
});
