import Redis from 'ioredis';
import { env } from '../config/env';

let redisClient: Redis | null = null;
let isRedisConnected = false;

// Local in-memory fallback store
const localCache = new Map<string, any>();

// Initialize Redis Client
try {
  // Configured with quick timeout (1.5 seconds) so it doesn't hang the process if Redis is missing
  redisClient = new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    connectTimeout: 1500,
    maxRetriesPerRequest: 1
  });

  redisClient.on('connect', () => {
    isRedisConnected = true;
    console.log('Redis connected successfully. High-speed socket cache active.');
  });

  redisClient.on('error', (err) => {
    isRedisConnected = false;
    // Log error once but suppress spam to avoid cluttering node console
  });
} catch (e) {
  console.log('Redis connection could not be established. Gracefully falling back to in-memory caching.');
}

// Caching APIs
export const setRoomCache = async (gamePin: string, data: any): Promise<void> => {
  try {
    if (isRedisConnected && redisClient) {
      // Store in Redis with a 2-hour TTL (7200 seconds) since active game rooms are transient
      await redisClient.set(`room:${gamePin}`, JSON.stringify(data), 'EX', 7200);
    } else {
      localCache.set(gamePin, data);
    }
  } catch (err) {
    // Fail-safe: write to local memory if Redis set fails
    localCache.set(gamePin, data);
  }
};

export const getRoomCache = async (gamePin: string): Promise<any | null> => {
  try {
    if (isRedisConnected && redisClient) {
      const cached = await redisClient.get(`room:${gamePin}`);
      return cached ? JSON.parse(cached) : null;
    } else {
      return localCache.get(gamePin) || null;
    }
  } catch (err) {
    // Fail-safe: read from local memory if Redis get fails
    return localCache.get(gamePin) || null;
  }
};

export const delRoomCache = async (gamePin: string): Promise<void> => {
  try {
    if (isRedisConnected && redisClient) {
      await redisClient.del(`room:${gamePin}`);
    } else {
      localCache.delete(gamePin);
    }
  } catch (err) {
    localCache.delete(gamePin);
  }
};

// Per-room mutex: getRoomCache/setRoomCache are separate read-then-write calls, so two
// socket handlers racing on the same gamePin (e.g. two players joining in the same
// instant) could both read the pre-update state and overwrite each other's change —
// silently dropping a joining player, not just letting the room exceed its cap.
// This serializes read-modify-write sections per room within this process.
const roomLocks = new Map<string, Promise<void>>();

export const withRoomLock = async <T>(gamePin: string, fn: () => Promise<T>): Promise<T> => {
  const previous = roomLocks.get(gamePin) || Promise.resolve();

  let releaseNext: () => void;
  const next = new Promise<void>((resolve) => { releaseNext = resolve; });
  roomLocks.set(gamePin, next);

  await previous;
  try {
    return await fn();
  } finally {
    releaseNext!();
    // Only clear the entry if nobody queued a newer lock behind us while we ran
    if (roomLocks.get(gamePin) === next) {
      roomLocks.delete(gamePin);
    }
  }
};
