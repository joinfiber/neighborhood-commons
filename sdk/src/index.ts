import createClient, { type Client } from "openapi-fetch";
import type { paths, components } from "./generated/schema.js";

export interface CommonsClientOptions {
  baseUrl?: string;
  apiKey?: string;
}

const DEFAULT_BASE_URL = "https://api.neighborhood-commons.org/api/v1";

export function createCommonsClient(opts: CommonsClientOptions = {}): Client<paths> {
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers["X-API-Key"] = opts.apiKey;

  return createClient<paths>({
    baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
    headers,
  });
}

export type { paths, components } from "./generated/schema.js";

export type Meta = components["schemas"]["Meta"];
export type Event = components["schemas"]["Event"];
export type Source = components["schemas"]["Source"];
export type Account = components["schemas"]["Account"];
export type Group = components["schemas"]["Group"];
export type Webhook = components["schemas"]["Webhook"];
export type ErrorCode = components["schemas"]["ErrorCode"];
export type ApiError = components["schemas"]["Error"];
