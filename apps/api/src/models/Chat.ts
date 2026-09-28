import { Schema, model } from "mongoose";

const chatSchema = new Schema(
  {
    type: { type: String, enum: ["direct", "group"], required: true },
    title: { type: String, trim: true, maxlength: 80 },
    members: {
      type: [{ type: Schema.Types.ObjectId, ref: "User", required: true }],
      required: true,
      validate: {
        validator: function (this: { type?: string }, members: unknown[]) {
          const distinctMembers = new Set(members.map(String)).size === members.length;
          return distinctMembers && members.length >= 2 && (this.type !== "direct" || members.length === 2);
        },
        message: "Chat members must be unique, with exactly two for a direct chat"
      }
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    lastSeq: { type: Number, default: 0, min: 0 }
  },
  { timestamps: true }
);

chatSchema.index({ members: 1, updatedAt: -1 });

export const Chat = model("Chat", chatSchema);
