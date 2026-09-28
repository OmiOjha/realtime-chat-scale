import { createServer } from "node:http";
import mongoose from "mongoose";
import Redis from "ioredis";
import { createApp } from "./app";
import { getEnvironment } from "./config/env";
import { Chat } from "./models/Chat";
import { Message } from "./models/Message";
import { User } from "./models/User";
import { attachSocketServer, closeSocketRedisClients } from "./socket";

async function start() {
  const environment = getEnvironment();
  await mongoose.connect(environment.MONGO_URI);
  const redis = new Redis(environment.REDIS_URL, { maxRetriesPerRequest: 2 });
  await redis.ping();
  await Promise.all([User.init(), Chat.init(), Message.init()]);

  const httpServer = createServer(createApp(redis));
  const io = await attachSocketServer(httpServer, redis);
  httpServer.listen(environment.PORT, () => {
    console.info(`API listening on http://localhost:${environment.PORT}`);
  });

  const shutdown = async () => {
    await closeSocketRedisClients(io);
    await redis.quit();
    await mongoose.disconnect();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

start().catch((error: unknown) => {
  console.error("Could not start the API:", error);
  process.exitCode = 1;
});
