import { resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: resolve(__dirname, "../../../../.env") });

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGO_URI: z.string().min(1).default("mongodb://localhost:27017/realtime-chat"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must contain at least 32 characters"),
  CLIENT_ORIGIN: z.string().url().default("http://localhost:5173")
});

export function getEnvironment() {
  return environmentSchema.parse(process.env);
}
