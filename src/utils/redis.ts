import Redis from "ioredis";
import { redisConnection } from "./env";

const withRedis = async <T>(operation: (client: Redis) => Promise<T>) => {
  const client = new Redis({
    ...redisConnection,
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  try {
    await client.connect();
    return await operation(client);
  } finally {
    client.disconnect();
  }
};

export const set = async (
  key: string,
  value: string,
  expireInSeconds?: number,
) => {
  if (expireInSeconds) {
    return withRedis((client) =>
      expireInSeconds
        ? client.set(key, value, "EX", expireInSeconds)
        : client.set(key, value),
    );
  } else {
    return withRedis((client) => client.set(key, value));
  }
};

export const get = async (key: string) => {
  return withRedis((client) => client.get(key));
};

export const del = async (key: string) => {
  return withRedis((client) => client.del(key));
};

// Atomically increments a counter, starting the expiry window on first use.
export const incrementWithExpiry = async (key: string, windowSeconds: number) =>
  withRedis(async (client) => {
    const count = await client.incr(key);
    if (count === 1) await client.expire(key, windowSeconds);
    return count;
  });
