import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Chat } from "../models/Chat";
import { Message } from "../models/Message";
import { User } from "../models/User";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler, HttpError } from "../utils/errors";

const router = Router();

const createChatSchema = z.object({
  type: z.enum(["direct", "group"]),
  members: z.array(z.string().regex(/^[a-f\d]{24}$/i)).min(1).max(100),
  title: z.string().trim().max(80).optional()
});

router.use(requireAuth);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = createChatSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Chat details are invalid.");

    const memberIds = [...new Set([...parsed.data.members, req.userId!])];
    if (parsed.data.type === "direct" && memberIds.length !== 2) {
      throw new HttpError(400, "A direct chat must have exactly two members.");
    }
    if (parsed.data.type === "group" && memberIds.length < 2) {
      throw new HttpError(400, "A group chat must have at least two members.");
    }

    const validUsers = await User.countDocuments({ _id: { $in: memberIds } });
    if (validUsers !== memberIds.length) throw new HttpError(400, "One or more members do not exist.");

    const chat = await Chat.create({
      type: parsed.data.type,
      members: memberIds,
      createdBy: req.userId,
      ...(parsed.data.title ? { title: parsed.data.title } : {})
    });

    const populated = await Chat.findById(chat._id).populate("members", "email displayName");
    res.status(201).json({ chat: populated });
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const chats = await Chat.find({ members: req.userId })
      .sort({ updatedAt: -1 })
      .populate("members", "email displayName")
      .lean();

    const latestMessages = await Promise.all(
      chats.map((chat) => Message.findOne({ chatId: chat._id }).sort({ seq: -1 }).lean())
    );
    res.json({
      chats: chats.map((chat, index) => ({ ...chat, latestMessage: latestMessages[index] ?? null }))
    });
  })
);

router.get(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, "Chat ID is invalid.");
    const chat = await Chat.findOne({ _id: req.params.id, members: req.userId }).select("_id");
    if (!chat) throw new HttpError(404, "Chat not found.");

    const beforeSeqRaw = req.query.beforeSeq;
    const limitRaw = req.query.limit;
    const beforeSeq = beforeSeqRaw === undefined ? undefined : Number(beforeSeqRaw);
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (
      (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new HttpError(400, "Use a positive beforeSeq and a limit between 1 and 100.");
    }

    const filter: { chatId: mongoose.Types.ObjectId; seq?: { $lt: number } } = {
      chatId: chat._id as mongoose.Types.ObjectId
    };
    if (beforeSeq !== undefined) filter.seq = { $lt: beforeSeq };
    const messages = await Message.find(filter).sort({ seq: -1 }).limit(limit).lean();
    res.json({ messages: messages.reverse() });
  })
);

export default router;
