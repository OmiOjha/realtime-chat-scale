import type { Server as HttpServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import mongoose from "mongoose";
import Redis from "ioredis";
import { Server, Socket } from "socket.io";
import { z } from "zod";
import { getEnvironment } from "./config/env";
import { Chat } from "./models/Chat";
import { Message } from "./models/Message";
import { nextMessageSequence } from "./services/messageSequence";
import { isWithinRateLimit } from "./services/rateLimit";
import { isUserOnline, refreshPresence, removePresence } from "./services/presence";
import { verifyAccessToken } from "./utils/jwt";

type SocketResult =
  | { ok: true; message?: unknown; messages?: unknown[]; hasMore?: boolean; presence?: string[] }
  | { ok: false; error: string };
type Acknowledge = (result: SocketResult) => void;
type AuthenticatedSocket = Socket & { userId: string };
type JoinInput = { chatId: string; afterSeq?: number };

const messageSchema = z.object({
  chatId: z.string().regex(/^[a-f\d]{24}$/i),
  clientMsgId: z.string().trim().min(1).max(128),
  body: z.string().trim().min(1).max(4000)
});
const joinSchema = z.object({
  chatId: z.string().regex(/^[a-f\d]{24}$/i),
  afterSeq: z.number().int().nonnegative().default(0)
});
const stateSchema = z.object({
  chatId: z.string().regex(/^[a-f\d]{24}$/i),
  seq: z.number().int().positive()
});

function waitForRedisReady(client: Redis) {
  if (client.status === "ready") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    client.once("ready", resolve);
    client.once("error", reject);
  });
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

const adapterClients = new WeakMap<Server, [Redis, Redis]>();

export async function attachSocketServer(httpServer: HttpServer, redis: Redis) {
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();
  await Promise.all([waitForRedisReady(pubClient), waitForRedisReady(subClient)]);
  const io = new Server(httpServer, {
    cors: { origin: getEnvironment().CLIENT_ORIGIN }
  });
  io.adapter(createAdapter(pubClient, subClient));
  adapterClients.set(io, [pubClient, subClient]);

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string" || !token) {
      next(new Error("Authentication required"));
      return;
    }
    try {
      (socket as AuthenticatedSocket).userId = verifyAccessToken(token);
      next();
    } catch {
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
    const authenticatedSocket = socket as AuthenticatedSocket;
    const userId = authenticatedSocket.userId;
    const userRoom = (id: string) => `user:${id}`;
    const typingChats = new Set<string>();
    let presenceHeartbeat: ReturnType<typeof setInterval> | undefined;
    const presenceReady = Promise.resolve(authenticatedSocket.join(userRoom(userId)))
      .then(() => refreshPresence(redis, userId, authenticatedSocket.id))
      .then((count: number) => {
        if (count === 1) io.to(userRoom(userId)).emit("presence:update", { userId, online: true });
        if (authenticatedSocket.connected) {
          presenceHeartbeat = setInterval(() => {
            void refreshPresence(redis, userId, authenticatedSocket.id)
              .catch((error: unknown) => console.error("Could not refresh online presence:", error));
          }, 20_000);
          presenceHeartbeat.unref();
        }
      });
    void presenceReady.catch((error: unknown) => console.error("Could not update online presence:", error));

    authenticatedSocket.on("chat:join", (input: JoinInput, acknowledge?: Acknowledge) => {
      void (async () => {
        try {
          const parsed = joinSchema.safeParse(input);
          if (!parsed.success) {
            acknowledge?.({ ok: false, error: "Chat details are invalid." });
            return;
          }
          const { chatId, afterSeq } = parsed.data;
          const chat = await Chat.findOne({ _id: chatId, members: userId }).select("members").lean();
          if (!chat) {
            acknowledge?.({ ok: false, error: "Chat not found." });
            return;
          }

          await authenticatedSocket.join(`chat:${chatId}`);
          await Promise.all(chat.members.map((memberId) => authenticatedSocket.join(userRoom(String(memberId)))));
          await presenceReady;
          const [messageBatch, presence] = await Promise.all([
            Message.find({ chatId, seq: { $gt: afterSeq } })
              .sort({ seq: 1 })
              .limit(101)
              .lean(),
            Promise.all(chat.members.map(async (memberId) => (
              await isUserOnline(redis, String(memberId)) ? String(memberId) : null
            )))
          ]);
          const hasMore = messageBatch.length > 100;
          acknowledge?.({
            ok: true,
            messages: messageBatch.slice(0, 100),
            hasMore,
            presence: presence.filter((id): id is string => id !== null)
          });
        } catch (error) {
          console.error("Could not join chat room:", error);
          acknowledge?.({ ok: false, error: "Could not join this chat." });
        }
      })();
    });

    authenticatedSocket.on("message:send", (input: unknown, acknowledge?: Acknowledge) => {
      void (async () => {
        try {
          const parsed = messageSchema.safeParse(input);
          if (!parsed.success) {
            acknowledge?.({ ok: false, error: "Message details are invalid." });
            return;
          }
          if (!(await isWithinRateLimit(redis, `limit:message:${userId}`, 60, 60_000))) {
            acknowledge?.({ ok: false, error: "You are sending messages too quickly. Try again in a moment." });
            return;
          }
          const { chatId, clientMsgId, body } = parsed.data;
          const chat = await Chat.findOne({ _id: chatId, members: userId }).select("_id");
          if (!chat) {
            acknowledge?.({ ok: false, error: "Chat not found." });
            return;
          }

          const idempotencyFilter = { chatId, senderId: userId, clientMsgId };
          const existing = await Message.findOne(idempotencyFilter).lean();
          if (existing) {
            if (existing.body !== body) {
              acknowledge?.({ ok: false, error: "This client message ID was already used for another message." });
              return;
            }
            acknowledge?.({ ok: true, message: existing });
            return;
          }

          const lastMessage = await Message.findOne({ chatId }).sort({ seq: -1 }).select("seq").lean();
          const seq = await nextMessageSequence(redis, chatId, lastMessage?.seq ?? 0);
          let savedMessage;
          try {
            const message = await Message.create({
              chatId,
              senderId: userId,
              clientMsgId,
              seq,
              body
            });
            savedMessage = message.toObject();
          } catch (error) {
            if (!isDuplicateKey(error)) throw error;
            const duplicate = await Message.findOne(idempotencyFilter).lean();
            if (!duplicate) throw error;
            if (duplicate.body !== body) {
              acknowledge?.({ ok: false, error: "This client message ID was already used for another message." });
              return;
            }
            acknowledge?.({ ok: true, message: duplicate });
            return;
          }

          try {
            await Chat.updateOne({ _id: chatId }, {
              $max: { lastSeq: seq, updatedAt: savedMessage.createdAt }
            }, { timestamps: false });
          } catch (error) {
            console.error("Message was saved but chat recency could not be updated:", error);
          }
          io.to(`chat:${chatId}`).emit("message:new", savedMessage);
          acknowledge?.({ ok: true, message: savedMessage });
        } catch (error) {
          console.error("Could not send message:", error);
          acknowledge?.({ ok: false, error: "Message could not be saved." });
        }
      })();
    });

    for (const event of ["message:delivered", "message:read"] as const) {
      authenticatedSocket.on(event, (input: unknown, acknowledge?: Acknowledge) => {
        void (async () => {
          try {
            const parsed = stateSchema.safeParse(input);
            if (!parsed.success) {
              acknowledge?.({ ok: false, error: "Message status details are invalid." });
              return;
            }
            const { chatId, seq } = parsed.data;
            const member = await Chat.exists({ _id: chatId, members: userId });
            if (!member) {
              acknowledge?.({ ok: false, error: "Chat not found." });
              return;
            }
            const stateField = event === "message:read" ? "readBy" : "deliveredTo";
            const message = await Message.findOneAndUpdate(
              { chatId, seq, senderId: { $ne: userId } },
              { $addToSet: { [stateField]: userId } },
              { new: true }
            );
            if (!message) {
              acknowledge?.({ ok: false, error: "Message not found." });
              return;
            }
            const update = { chatId, seq, deliveredTo: message.deliveredTo, readBy: message.readBy };
            io.to(`chat:${chatId}`).emit("message:status", update);
            acknowledge?.({ ok: true, message: update });
          } catch (error) {
            console.error("Could not update message status:", error);
            acknowledge?.({ ok: false, error: "Message status could not be updated." });
          }
        })();
      });
    }

    for (const event of ["typing:start", "typing:stop"] as const) {
      authenticatedSocket.on(event, (chatId: string) => {
        void (async () => {
          try {
            if (
              !mongoose.isValidObjectId(chatId) ||
              (event === "typing:start" &&
                !(await isWithinRateLimit(redis, `limit:typing:${userId}`, 90, 60_000)))
            ) return;
            const member = await Chat.exists({ _id: chatId, members: userId });
            if (member) {
              if (event === "typing:start") typingChats.add(chatId);
              else typingChats.delete(chatId);
              authenticatedSocket.to(`chat:${chatId}`).emit(event, { chatId, userId });
            }
          } catch (error) {
            console.error("Could not update typing state:", error);
          }
        })();
      });
    }

    authenticatedSocket.on("disconnect", () => {
      if (presenceHeartbeat) clearInterval(presenceHeartbeat);
      typingChats.forEach((chatId) => {
        authenticatedSocket.to(`chat:${chatId}`).emit("typing:stop", { chatId, userId });
      });
      void presenceReady.then(() => removePresence(redis, userId, authenticatedSocket.id)).then((remaining) => {
        if (remaining === 0) io.to(userRoom(userId)).emit("presence:update", { userId, online: false });
      }).catch((error: unknown) => console.error("Could not update offline presence:", error));
    });
  });

  return io;
}

export async function closeSocketRedisClients(io: Server) {
  const server = io;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const clients = adapterClients.get(server);
  if (clients) await Promise.all(clients.map((client) => client.quit()));
}

export type { JoinInput, SocketResult };
