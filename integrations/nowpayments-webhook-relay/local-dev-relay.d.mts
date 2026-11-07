import type { Server } from "node:http";

export const MAX_BODY_BYTES: number;

export function createLocalRelayServer(options?: {
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
}): Server;
