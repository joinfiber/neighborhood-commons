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

export { assertPublicPayload } from "./assert-public-payload.js";

export type { paths, components } from "./generated/schema.js";

export type Meta = components["schemas"]["Meta"];
export type Event = components["schemas"]["Event"];
export type Source = components["schemas"]["Source"];
// 3.1: public-facing identity of each contributing app.
export type ContributorProfile = components["schemas"]["ContributorProfile"];
// v2 (2.0.0): Person, Verifier, VerifierApproval, Account, Group types
// were retired. Use ServiceAccount for the operational portal-account shell
// and Organization for the unified entity primitive.
export type ServiceAccount = components["schemas"]["ServiceAccount"];
export type ServiceEvent = components["schemas"]["ServiceEvent"];
export type Place = components["schemas"]["Place"];
export type Organization = components["schemas"]["Organization"];
export type Broadcast = components["schemas"]["Broadcast"];
export type List = components["schemas"]["List"];
export type Webhook = components["schemas"]["Webhook"];
export type ErrorCode = components["schemas"]["ErrorCode"];
export type ApiError = components["schemas"]["Error"];
