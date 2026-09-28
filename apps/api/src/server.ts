import { createServer } from "node:http";
import mongoose from "mongoose";
import { createApp } from "./app";
import { getEnvironment } from "./config/env";
import { attachSocketServer } from "./socket";

async function start() {
  const environment = getEnvironment();
  await mongoose.connect(environment.MONGO_URI);

  const httpServer = createServer(createApp());
  attachSocketServer(httpServer);
  httpServer.listen(environment.PORT, () => {
    console.info(`API listening on http://localhost:${environment.PORT}`);
  });
}

start().catch((error: unknown) => {
  console.error("Could not start the API:", error);
  process.exitCode = 1;
});
