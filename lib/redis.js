// One Upstash client for the whole app, created on first use.
//
// Routes used to build their own client at import time, which meant a missing
// environment variable threw during a cold start even for requests that never
// touched Redis. This keeps the same env names and memoises a single client,
// so tests can import a handler without any credentials configured.
import { Redis } from '@upstash/redis';

let client = null;

// Tests inject an in-memory store instead of a real connection.
export function __setKvForTests(store) {
  client = store;
}

export function getKv() {
  if (!client) {
    client = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
    });
  }
  return client;
}
