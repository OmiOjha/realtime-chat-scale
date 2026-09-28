import { Schema, model } from "mongoose";

const messageSchema = new Schema(
  {
    chatId: { type: Schema.Types.ObjectId, ref: "Chat", required: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    clientMsgId: { type: String, required: true, trim: true, maxlength: 128 },
    seq: { type: Number, required: true, min: 1 },
    body: { type: String, required: true, trim: true, minlength: 1, maxlength: 4000 },
    createdAt: { type: Date, default: Date.now },
    deliveredTo: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] },
    readBy: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] }
  },
  { versionKey: false }
);

messageSchema.index({ chatId: 1, seq: 1 }, { unique: true });
messageSchema.index({ chatId: 1, senderId: 1, clientMsgId: 1 }, { unique: true });
messageSchema.index({ chatId: 1, createdAt: -1 });

export const Message = model("Message", messageSchema);
