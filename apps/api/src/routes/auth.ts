import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/User";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler, HttpError } from "../utils/errors";
import { createAccessToken } from "../utils/jwt";

const router = Router();

const registerSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(60),
  password: z.string().min(8).max(72)
});
const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(72)
});

function publicUser(user: { _id: unknown; email: string; displayName: string }) {
  return { id: String(user._id), email: user.email, displayName: user.displayName };
}

router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Enter a valid email, display name, and password of 8–72 characters.");

    const email = parsed.data.email.toLowerCase();
    if (await User.exists({ email })) throw new HttpError(409, "An account with this email already exists.");

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const user = await User.create({ ...parsed.data, email, passwordHash });
    res.status(201).json({ user: publicUser(user), token: createAccessToken(String(user._id)) });
  })
);

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Enter a valid email and password.");

    const user = await User.findOne({ email: parsed.data.email.toLowerCase() }).select("+passwordHash");
    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
      throw new HttpError(401, "Email or password is incorrect.");
    }

    res.json({ user: publicUser(user), token: createAccessToken(String(user._id)) });
  })
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) throw new HttpError(401, "Account no longer exists.");
    res.json({ user: publicUser(user) });
  })
);

export default router;
