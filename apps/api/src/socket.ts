import type { Server as HttpServer } from "node:http";
import { Server, Socket } from "socket.io";
import mongoose from "mongoose";
import { z } from "zod";
import { getEnvironment } from "./config/env";
import { Chat } from "./models/Chat";
import { Message } from "./models/Message";
import { verifyAccessToken } from "./utils/jwt";

type ClientEvents = {
  "chat:join": (chatId: string, acknowledge?: (result: SocketResult) => void) => void;
  "message:send": (message: unknown, acknowledge?: (result: SocketResult) => void) => void;
};
type SocketResult =
  | { ok: true; message?: unknown }
  | { ok: false; error: string };
type AuthenticatedSocket = Socket<ClientEvents> & { userId?: string };

const messageSchema = z.object({
  chatId: z.string().regex(/^[a-f\d]{24}$/i),
  clientMsgId: z.string().trim().min(1).max(128),
  body: z.string().trim().min(1).max(4000)
});

export function attachSocketServer(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: { origin: getEnvironment().CLIENT_ORIGIN }
  });

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
    const userId = authenticatedSocket.userId!;

    authenticatedSocket.on("chat:join", (chatId, acknowledge) => {
      void (async () => {
        try {
          if (!mongoose.isValidObjectId(chatId)) {
            acknowledge?.({ ok: false, error: "Chat ID is invalid." });
            return;
          }
          const chat = await Chat.exists({ _id: chatId, members: userId });
          if (!chat) {
            acknowledge?.({ ok: false, error: "Chat not found." });
            return;
          }
          await authenticatedSocket.join(`chat:${chatId}`);
          acknowledge?.({ ok: true });
        } catch (error) {
          console.error("Could not join chat room:", error);
          acknowledge?.({ ok: false, error: "Could not join this chat." });
        }
      })();
    });

    authenticatedSocket.on("message:send", (input, acknowledge) => {
      void (async () => {
        try {
          const parsed = messageSchema.safeParse(input);
          if (!parsed.success) {
            acknowledge?.({ ok: false, error: "Message details are invalid." });
            return;
          }

          const chat = await Chat.findOneAndUpdate(
            { _id: parsed.data.chatId, members: userId },
            { $inc: { lastSeq: 1 } },
            { new: true, projection: { lastSeq: 1 } }
          );
          if (!chat) {
            acknowledge?.({ ok: false, error: "Chat not found." });
            return;
          }

          const message = await Message.create({
            chatId: parsed.data.chatId,
            senderId: userId,
            clientMsgId: parsed.data.clientMsgId,
            seq: chat.lastSeq,
            body: parsed.data.body
          });
          await Chat.updateOne({ _id: chat._id }, { $set: { updatedAt: message.createdAt } });
          const savedMessage = message.toObject();
          io.to(`chat:${parsed.data.chatId}`).emit("message:new", savedMessage);
          acknowledge?.({ ok: true, message: savedMessage });
        } catch (error) {
          console.error("Could not send message:", error);
          acknowledge?.({ ok: false, error: "Message could not be saved." });
        }
      })();
    });
  });

  return io;
}
