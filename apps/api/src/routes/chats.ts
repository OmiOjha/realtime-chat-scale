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
  members: z.array(z.string().refine(
    (value) => /^[a-f\d]{24}$/i.test(value) || z.string().email().safeParse(value).success
  )).min(1).max(100),
  title: z.string().trim().max(80).optional()
});

router.use(requireAuth);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = createChatSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Chat details are invalid.");

    const suppliedMembers = [...new Set(parsed.data.members)];
    const memberQueries = suppliedMembers.map((value) =>
      mongoose.isValidObjectId(value) ? { _id: value } : { email: value.toLowerCase() }
    );
    const users = await User.find({ $or: memberQueries }).select("_id email");
    const foundValues = new Set(users.flatMap((user) => [String(user._id).toLowerCase(), user.email]));
    if (suppliedMembers.some((value) => !foundValues.has(value.toLowerCase()))) {
      throw new HttpError(400, "One or more members do not exist.");
    }

    const memberIds = [...new Set([...users.map((user) => String(user._id)), req.userId!])];
    if (parsed.data.type === "direct" && memberIds.length !== 2) {
      throw new HttpError(400, "A direct chat must have exactly two members.");
    }
    if (parsed.data.type === "group" && memberIds.length < 2) {
      throw new HttpError(400, "A group chat must have at least two members.");
    }

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
    const afterSeqRaw = req.query.afterSeq;
    const limitRaw = req.query.limit;
    const beforeSeq = beforeSeqRaw === undefined ? undefined : Number(beforeSeqRaw);
    const afterSeq = afterSeqRaw === undefined ? undefined : Number(afterSeqRaw);
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (
      (beforeSeq !== undefined && afterSeq !== undefined) ||
      (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) ||
      (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new HttpError(400, "Use either a valid beforeSeq or afterSeq and a limit between 1 and 100.");
    }

    const filter: { chatId: mongoose.Types.ObjectId; seq?: { $lt?: number; $gt?: number } } = {
      chatId: chat._id as mongoose.Types.ObjectId
    };
    if (beforeSeq !== undefined) filter.seq = { $lt: beforeSeq };
    if (afterSeq !== undefined) filter.seq = { $gt: afterSeq };
    const messages = await Message.find(filter)
      .sort({ seq: beforeSeq === undefined ? 1 : -1 })
      .limit(limit)
      .lean();
    res.json({ messages: beforeSeq === undefined ? messages : messages.reverse() });
  })
);

export default router;
