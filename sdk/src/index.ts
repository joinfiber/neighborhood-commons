import createClient, { type Client } from "openapi-fetch";
import type { paths, components } from "./generated/schema.js";

export interface CommonsClientOptions {
  baseUrl?: string;
  apiKey?: string;
}

const DEFAULT_BASE_URL = "https://neighborhood-commons.org/api/v1";

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
// Legacy `Account` and `Group` types were removed from the spec in 1.0.0.
// Use `ServiceAccount` for the service-tier portal-account read shape and
// `Organization` for the new collective-entity type that supersedes Group.
export type ServiceAccount = components["schemas"]["ServiceAccount"];
export type ServiceEvent = components["schemas"]["ServiceEvent"];
export type Place = components["schemas"]["Place"];
export type Organization = components["schemas"]["Organization"];
export type Person = components["schemas"]["Person"];
export type Broadcast = components["schemas"]["Broadcast"];
export type List = components["schemas"]["List"];
export type Webhook = components["schemas"]["Webhook"];
export type ErrorCode = components["schemas"]["ErrorCode"];
export type ApiError = components["schemas"]["Error"];
