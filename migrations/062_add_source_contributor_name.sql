-- Migration 062: Add source_contributor_name column to events
-- Decouples contributor identity from source_publisher. Previously
-- `source.contributor.name` in the public API was overloaded to render
-- from `source_publisher` on source_method='api' events — fine when a
-- contribute-path caller set source_publisher to the app name, but wrong
-- for Service-API callers where source_publisher is the venue and the
-- per-event app/sub-publisher has nowhere to go.
--
-- Service API now accepts an optional `contributor: { name, url }` that
-- persists to `source_contributor_name` + `source_contributor_url`. The
-- read-path fallback chain is preserved: when the new column is null,
-- event-transform.ts still derives contributor from source_publisher on
-- api-method events, so every existing caller's payload is unchanged.

ALTER TABLE events ADD COLUMN IF NOT EXISTS source_contributor_name text;
