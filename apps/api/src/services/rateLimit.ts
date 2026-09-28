import type Redis from "ioredis";

const consumeFixedWindow = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return count
`;

export async function isWithinRateLimit(
  redis: Redis,
  key: string,
  maximum: number,
  windowMilliseconds: number
) {
  const count = Number(await redis.eval(consumeFixedWindow, 1, key, String(windowMilliseconds)));
  return count <= maximum;
}
