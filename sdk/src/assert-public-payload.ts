/**
 * Defensive PII-boundary check for consumer apps publishing into the Commons.
 *
 * The Commons stores public facts — events, organizations, places. Consumer
 * apps that publish on behalf of operators must NOT leak operator PII into
 * Commons payloads: no operator emails, phone numbers, account IDs from the
 * consumer's own system, internal user IDs, etc.
 *
 * The tenant-umbrella pattern (Merrie, GoThere, …) makes this especially
 * load-bearing: the consumer's *contract* with the Commons is "I will send
 * no operator PII." `assertPublicPayload` is a cheap runtime check that
 * surfaces a contract violation before the payload hits the wire.
 *
 * Usage:
 *
 *   import { assertPublicPayload } from "neighborhood-commons";
 *
 *   const ALLOWED_EVENT_KEYS = new Set([
 *     "organizerOrganizationId", "name", "start", "end", "timezone", "category",
 *     "location", "description", "cost", "url", "image_url", "tags",
 *   ]);
 *
 *   function syncEvent(body: Record<string, unknown>) {
 *     assertPublicPayload(body, ALLOWED_EVENT_KEYS, "event");
 *     return commons.POST("/service/events", { body });
 *   }
 *
 * Throws synchronously on the first disallowed key. Returns void on success.
 */
export function assertPublicPayload(
  body: Record<string, unknown>,
  allowedKeys: ReadonlySet<string> | readonly string[],
  label: string = "payload",
): void {
  const allowed: ReadonlySet<string> = allowedKeys instanceof Set
    ? allowedKeys
    : new Set(allowedKeys);

  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new Error(
        `PII boundary violation: ${label} body contains disallowed key "${key}"`,
      );
    }
  }
}
