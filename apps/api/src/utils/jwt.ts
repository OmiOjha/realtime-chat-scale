import jwt from "jsonwebtoken";
import { getEnvironment } from "../config/env";

export function createAccessToken(userId: string) {
  return jwt.sign({}, getEnvironment().JWT_SECRET, { subject: userId, expiresIn: "7d" });
}

export function verifyAccessToken(token: string): string {
  const payload = jwt.verify(token, getEnvironment().JWT_SECRET);
  if (typeof payload === "string" || !payload.sub) {
    throw new Error("Invalid token subject");
  }
  return payload.sub;
}
