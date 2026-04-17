/**
 * iCal / RFC 5545 text encoding — Neighborhood Commons
 *
 * Single source of truth for escaping text values written into .ics output.
 * Previously inlined in three places (`escapeICalText` in v1.ts, `esc` in
 * pages.ts twice). All three missed CR (\r), which — combined with the
 * un-escaped `URL:` field — made CRLF injection possible if a link_url
 * contained a raw CR/LF.
 *
 * The threat model: a venue's `link_url` ends up as `URL:<value>` in the
 * feed. If an attacker can plant `\r\n` inside that value (e.g. via a poorly
 * validated insert path, or legacy imported data), the feed splits into an
 * attacker-controlled VEVENT that phishes via any subscriber's calendar app.
 *
 * Defense: escape CR/LF/BS/comma/semicolon per RFC 5545 §3.3.11 and strip
 * any remaining control characters. Apply to every text field including
 * URL (the spec doesn't require escaping URL values, but doing so keeps
 * one consistent policy and is harmless for legitimate URLs).
 */

/**
 * Escape a text value for safe inclusion in an iCalendar property body.
 * Escapes backslash, semicolon, comma, newline (LF), carriage return (CR),
 * then strips any remaining control characters (C0 range except escaped ones).
 */
export function icsEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    // Strip remaining C0 control chars except tab (which RFC 5545 permits).
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
}

/**
 * Extra-paranoid URL sanitizer for iCal URL: fields. Rejects values
 * containing raw control characters by returning null — the caller should
 * omit the URL: line entirely rather than emit something suspect.
 *
 * Also handles the case where a malicious value smuggles a second property
 * on the same line via a comma or semicolon (these are now escaped by
 * icsEscape, but we bail out on truly malformed input).
 */
export function icsSafeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Reject if contains any control char — these have no business in a URL
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(raw)) return null;
  return icsEscape(raw);
}
