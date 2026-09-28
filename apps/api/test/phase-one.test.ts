import { createServer, Server as HttpServer } from "node:http";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { io as createClient, Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { createApp } from "../src/app";
import { attachSocketServer } from "../src/socket";

jest.setTimeout(60000);

describe("Phase 1 API and Socket.IO", () => {
  let mongo: MongoMemoryServer;
  let httpServer: HttpServer;
  let serverAddress: string;
  let socketServer: ReturnType<typeof attachSocketServer>;
  let clients: ClientSocket[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-characters";
    process.env.CLIENT_ORIGIN = "http://localhost:5173";
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    httpServer = createServer(createApp());
    socketServer = attachSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");
    serverAddress = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    clients.forEach((client) => client.disconnect());
    clients = [];
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    await mongoose.disconnect();
    await mongo.stop();
  });

  async function register(email: string, displayName: string) {
    return request(httpServer)
      .post("/auth/register")
      .send({ email, displayName, password: "secure-passphrase" });
  }

  function connect(token: string) {
    const client = createClient(serverAddress, {
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
      .send({ type: "direct", members: [second.body.user.id] });
    expect(created.status).toBe(201);
    const chatId = created.body.chat._id as string;

    expect((await request(httpServer)
      .get(`/chats/${chatId}/messages`)
      .set("Authorization", `Bearer ${outsiderToken}`)).status).toBe(404);
    expect((await request(httpServer)
      .get("/chats")
      .set("Authorization", `Bearer ${secondToken}`)).body.chats).toHaveLength(1);

    const sender = connect(firstToken);
    const recipient = connect(secondToken);
    await Promise.all([waitForConnect(sender), waitForConnect(recipient)]);
    const invalidClient = connect("not-a-valid-token");
    await expect(waitForConnectError(invalidClient)).resolves.toThrow("Invalid or expired token");

    expect(await emitWithAck(recipient, "chat:join", chatId)).toMatchObject({ ok: true });
    expect(await emitWithAck(sender, "chat:join", chatId)).toMatchObject({ ok: true });
    const unauthorized = connect(outsiderToken);
    await waitForConnect(unauthorized);
    expect(await emitWithAck(unauthorized, "chat:join", chatId)).toMatchObject({ ok: false });
    expect(await emitWithAck(unauthorized, "message:send", {
      chatId,
      clientMsgId: "unauthorized",
      body: "Not allowed"
    })).toMatchObject({ ok: false });

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

    const secondSent = await emitWithAck(sender, "message:send", {
      chatId,
      clientMsgId: "client-2",
      body: "A second note"
    });
    expect(secondSent).toMatchObject({ ok: true, message: { body: "A second note", seq: 2 } });

    const paged = await request(httpServer)
      .get(`/chats/${chatId}/messages?beforeSeq=2&limit=1`)
      .set("Authorization", `Bearer ${firstToken}`);
    expect(paged.status).toBe(200);
    expect(paged.body.messages).toHaveLength(1);
    expect(paged.body.messages[0].clientMsgId).toBe("client-1");
    expect((await request(httpServer)
      .get(`/chats/${chatId}/messages?limit=0`)
      .set("Authorization", `Bearer ${firstToken}`)).status).toBe(400);
  });
});
