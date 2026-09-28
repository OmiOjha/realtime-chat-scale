import type { RequestHandler } from "express";
import type Redis from "ioredis";
import { isWithinRateLimit } from "../services/rateLimit";

export function rateLimit(
  redis: Redis,
  options: { scope: string; maximum: number; windowMilliseconds: number }
): RequestHandler {
  return (req, res, next) => {
    void isWithinRateLimit(
      redis,
      `limit:http:${options.scope}:${req.ip}`,
      options.maximum,
      options.windowMilliseconds
    ).then((allowed) => {
      if (!allowed) {
        res.status(429).json({ error: "Too many requests. Please try again later." });
        return;
      }
      next();
    }).catch(next);
  };
}
