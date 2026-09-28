import cors from "cors";
import express from "express";
import type Redis from "ioredis";
import { getEnvironment } from "./config/env";
import { rateLimit } from "./middleware/rateLimit";
import authRoutes from "./routes/auth";
import chatRoutes from "./routes/chats";
import { HttpError } from "./utils/errors";

export function createApp(redis?: Redis) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(cors({ origin: getEnvironment().CLIENT_ORIGIN }));
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  if (redis) {
    app.use("/auth/register", rateLimit(redis, { scope: "register", maximum: 5, windowMilliseconds: 60 * 60_000 }));
    app.use("/auth/login", rateLimit(redis, { scope: "login", maximum: 10, windowMilliseconds: 15 * 60_000 }));
  }
  app.use("/auth", authRoutes);
  app.use("/chats", chatRoutes);

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError && "status" in error && error.status === 400) {
      res.status(400).json({ error: "Request body must be valid JSON." });
      return;
    }
    if (error instanceof Error && error.name === "ValidationError") {
      res.status(400).json({ error: "Submitted data is invalid." });
      return;
    }
    if (error instanceof Error && error.name === "MongoServerError" && "code" in error && error.code === 11000) {
      res.status(409).json({ error: "An account with this email already exists." });
      return;
    }
    console.error("Unhandled request error:", error);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  return app;
}
