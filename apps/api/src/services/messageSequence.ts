import type Redis from "ioredis";

const incrementChatSequence = `
  local current = redis.call('GET', KEYS[1])
  local persisted = tonumber(ARGV[1])
  if not current or tonumber(current) < persisted then
    redis.call('SET', KEYS[1], persisted)
  end
  return redis.call('INCR', KEYS[1])
`;

export async function nextMessageSequence(
  redis: Redis,
  chatId: string,
  lastPersistedSequence: number
): Promise<number> {
  const sequence = await redis.eval(
    incrementChatSequence,
    1,
    `chat:${chatId}:sequence`,
    String(lastPersistedSequence)
  );
  return Number(sequence);
}
