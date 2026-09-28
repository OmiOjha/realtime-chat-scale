import type Redis from "ioredis";

const updatePresence = `
  local now = tonumber(ARGV[1])
  local expires = now + tonumber(ARGV[2])
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
  redis.call('ZADD', KEYS[1], expires, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return redis.call('ZCOUNT', KEYS[1], '(' .. now, '+inf')
`;
const removePresenceScript = `
  local now = tonumber(ARGV[1])
  redis.call('ZREM', KEYS[1], ARGV[2])
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
  local count = redis.call('ZCARD', KEYS[1])
  if count == 0 then redis.call('DEL', KEYS[1]); end
  return count
`;
const countPresence = `
  local now = tonumber(ARGV[1])
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
  return redis.call('ZCARD', KEYS[1])
`;

const presenceTtlMilliseconds = 60_000;
const presenceKey = (userId: string) => `presence:${userId}:sockets`;

export async function refreshPresence(redis: Redis, userId: string, socketId: string) {
  return Number(await redis.eval(
    updatePresence,
    1,
    presenceKey(userId),
    String(Date.now()),
    String(presenceTtlMilliseconds),
    socketId
  ));
}

export async function removePresence(redis: Redis, userId: string, socketId: string) {
  return Number(await redis.eval(
    removePresenceScript,
    1,
    presenceKey(userId),
    String(Date.now()),
    socketId
  ));
}

export async function isUserOnline(redis: Redis, userId: string) {
  return Number(await redis.eval(
    countPresence,
    1,
    presenceKey(userId),
    String(Date.now())
  )) > 0;
}
