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

/** Reads and removes the key in one step, so a one-time value can only be claimed once. */
export const getAndDelete = async (key: string) => withRedis((client) => client.getdel(key));

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

/** Sets the key only if it does not exist yet. Returns false when it already did, which makes it a cooldown lock. */
export const setIfAbsent = async (key: string, value: string, expireInSeconds: number) =>
  withRedis(async (client) => (await client.set(key, value, "EX", expireInSeconds, "NX")) === "OK");

/** Seconds until the key expires; 0 when it is missing. */
export const secondsLeft = async (key: string) => withRedis(async (client) => Math.max(0, await client.ttl(key)));
