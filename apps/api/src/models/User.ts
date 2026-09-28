import { Schema, model } from "mongoose";

const userSchema = new Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    displayName: { type: String, required: true, trim: true, minlength: 1, maxlength: 60 },
    passwordHash: { type: String, required: true, select: false }
  },
  { timestamps: true }
);

userSchema.index({ email: 1 }, { unique: true });

export const User = model("User", userSchema);
