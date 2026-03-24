/**
 * Admin Ingestion Routes
 *
 * Newsletter sources, emails, feed sources, and event candidate review.
 * Approve, reject, duplicate, and batch-approve candidates.
 */

import { Router } from "express";
import { z } from "zod";
import { EVENT_CATEGORY_KEYS } from "../../lib/categories.js";
import { validateTags } from "../../lib/tags.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { createError } from "../../middleware/error-handler.js";
import { validateRequest, validateUuidParam } from "../../lib/helpers.js";
import { config } from "../../config.js";
import { dispatchWebhooks } from "../../lib/webhook-delivery.js";
import { auditPortalAction } from "../../lib/audit.js";
import { toNeighborhoodEvent, type PortalEventRow } from "../../lib/event-transform.js";
import { geocodeEventIfNeeded } from "../../lib/geocoding.js";
import { pollFeedSource } from "../../lib/feed-polling.js";
import { writeLimiter, portalLimiter } from "../../middleware/rate-limit.js";
import {
  PORTAL_SELECT, toTimestamptz, getAdminUserId,
} from "../../lib/event-operations.js";
import { downloadAndAttachImage } from "../../lib/image-processing.js";

const router: ReturnType<typeof Router> = Router();

// =============================================================================
// NEWSLETTER INGESTION — Sources, Emails, and Event Candidates
// =============================================================================

const createNewsletterSourceSchema = z.object({
  name: z.string().min(1).max(200),
  sender_email: z.string().email().max(320).optional(),
  notes: z.string().max(2000).optional(),
  auto_approve: z.boolean().optional().default(false),
});

const updateNewsletterSourceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  sender_email: z.string().email().max(320).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  auto_approve: z.boolean().optional(),
  status: z.enum(['active', 'paused', 'retired']).optional(),
});

const approveCandidateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  venue_name: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
  place_id: z.string().max(300).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]).optional(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (expected YYYY-MM-DD)').optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Invalid time format (expected HH:MM)').transform(t => t.slice(0, 5)).optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Invalid time format (expected HH:MM)').transform(t => t.slice(0, 5)).optional(),
  price: z.string().max(100).optional(),
  tags: z.array(z.string().max(50)).max(15).optional(),
  event_timezone: z.string().max(50).optional(),
});

const rejectCandidateSchema = z.object({
  review_notes: z.string().max(2000).optional(),
});

const duplicateCandidateSchema = z.object({
  matched_event_id: z.string().uuid().optional(),
});

// ─── Newsletter Sources ─────────────────────────────────────────

router.get('/newsletter-sources', portalLimiter, async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('newsletter_sources')
      .select('id, name, sender_email, notes, auto_approve, status, created_at, last_received_at')
      .order('last_received_at', { ascending: false, nullsFirst: false });

    if (error) {
      console.error('[COMMONS-ADMIN] Newsletter sources list error:', error.message);
      throw createError('Failed to list newsletter sources', 500, 'SERVER_ERROR');
    }

    res.json({ sources: data || [] });
  } catch (err) {
    next(err);
  }
});

router.post('/newsletter-sources', writeLimiter, async (req, res, next) => {
  try {
    const input = validateRequest(createNewsletterSourceSchema, req.body);

    const { data, error } = await supabaseAdmin
      .from('newsletter_sources')
      .insert({
        name: input.name,
        sender_email: input.sender_email || null,
        notes: input.notes || null,
        auto_approve: input.auto_approve,
      })
      .select('id, name, sender_email, notes, auto_approve, status, created_at, last_received_at')
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] Newsletter source create error:', error.message);
      throw createError('Failed to create newsletter source', 500, 'SERVER_ERROR');
    }

    console.log(`[COMMONS-ADMIN] Created newsletter source "${input.name}"`);
    res.status(201).json({ source: data });
  } catch (err) {
    next(err);
  }
});

router.patch('/newsletter-sources/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const input = validateRequest(updateNewsletterSourceSchema, req.body);

    // Build update object with only provided fields
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.sender_email !== undefined) updates.sender_email = input.sender_email;
    if (input.notes !== undefined) updates.notes = input.notes;
    if (input.auto_approve !== undefined) updates.auto_approve = input.auto_approve;
    if (input.status !== undefined) updates.status = input.status;

    if (Object.keys(updates).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const { data, error } = await supabaseAdmin
      .from('newsletter_sources')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, name, sender_email, notes, auto_approve, status, created_at, last_received_at')
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] Newsletter source update error:', error.message);
      throw createError('Failed to update newsletter source', 500, 'SERVER_ERROR');
    }

    if (!data) {
      throw createError('Newsletter source not found', 404, 'NOT_FOUND');
    }

    console.log(`[COMMONS-ADMIN] Updated newsletter source ${req.params.id}`);
    res.json({ source: data });
  } catch (err) {
    next(err);
  }
});

router.delete('/newsletter-sources/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');

    // Delete associated candidates first (via emails), then emails, then source
    const { data: emails } = await supabaseAdmin
      .from('newsletter_emails')
      .select('id')
      .eq('source_id', req.params.id);

    if (emails && emails.length > 0) {
      const emailIds = emails.map((e: { id: string }) => e.id);
      await supabaseAdmin
        .from('event_candidates')
        .delete()
        .in('email_id', emailIds);

      await supabaseAdmin
        .from('newsletter_emails')
        .delete()
        .eq('source_id', req.params.id);
    }

    // Also delete any candidates linked directly via source_id
    await supabaseAdmin
      .from('event_candidates')
      .delete()
      .eq('source_id', req.params.id);

    const { error } = await supabaseAdmin
      .from('newsletter_sources')
      .delete()
      .eq('id', req.params.id);

    if (error) {
      console.error('[COMMONS-ADMIN] Delete newsletter source error:', error.message);
      throw createError('Failed to delete newsletter source', 500, 'SERVER_ERROR');
    }

    console.log(`[COMMONS-ADMIN] Deleted newsletter source ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Newsletter Emails ──────────────────────────────────────────

router.get('/newsletter-emails', portalLimiter, async (req, res, next) => {
  try {
    const sourceId = typeof req.query.source_id === 'string' ? req.query.source_id : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    let query = supabaseAdmin
      .from('newsletter_emails')
      .select('id, source_id, message_id, sender_email, subject, received_at, processing_status, processing_error, candidate_count, newsletter_sources(name)')
      .order('received_at', { ascending: false })
      .limit(limit);

    if (sourceId) {
      validateUuidParam(sourceId, 'source_id');
      query = query.eq('source_id', sourceId);
    }
    if (status) {
      query = query.eq('processing_status', status);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[COMMONS-ADMIN] Newsletter emails list error:', error.message);
      throw createError('Failed to list newsletter emails', 500, 'SERVER_ERROR');
    }

    res.json({ emails: data || [] });
  } catch (err) {
    next(err);
  }
});

router.get('/newsletter-emails/:id', portalLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');

    const { data: email, error } = await supabaseAdmin
      .from('newsletter_emails')
      .select('id, source_id, message_id, sender_email, subject, body_html, body_plain, received_at, processing_status, processing_error, candidate_count, llm_response, newsletter_sources(name)')
      .eq('id', req.params.id)
      .single();

    if (error || !email) {
      throw createError('Newsletter email not found', 404, 'NOT_FOUND');
    }

    // Fetch candidates for this email
    const { data: candidates } = await supabaseAdmin
      .from('event_candidates')
      .select('id, title, description, start_date, start_time, end_time, location_name, location_address, location_lat, location_lng, source_url, confidence, status, matched_event_id, match_confidence, review_notes, created_at, reviewed_at, price, category, tags')
      .eq('email_id', req.params.id)
      .order('created_at', { ascending: true });

    res.json({ email, candidates: candidates || [] });
  } catch (err) {
    next(err);
  }
});

// ─── Feed Sources ───────────────────────────────────────────────

const FEED_TYPES = ['ical', 'rss', 'eventbrite', 'agile_ticketing'] as const;

const createFeedSourceSchema = z.object({
  name: z.string().min(1).max(200),
  feed_url: z.string().url(),
  feed_type: z.enum(FEED_TYPES).optional().default('ical'),
  poll_interval_hours: z.number().int().min(1).max(168).optional().default(24),
  default_location: z.string().max(500).optional(),
  default_timezone: z.string().max(100).optional().default('America/New_York'),
  notes: z.string().max(2000).optional(),
});

const updateFeedSourceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  feed_url: z.string().url().optional(),
  feed_type: z.enum(FEED_TYPES).optional(),
  poll_interval_hours: z.number().int().min(1).max(168).optional(),
  default_location: z.string().max(500).nullable().optional(),
  default_timezone: z.string().max(100).optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(['active', 'paused', 'retired']).optional(),
});

router.get('/feed-sources', portalLimiter, async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('feed_sources')
      .select('id, name, feed_url, feed_type, poll_interval_hours, status, default_location, default_timezone, notes, created_at, last_polled_at, last_poll_result, last_poll_error, last_event_count')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[COMMONS-ADMIN] Feed sources list error:', error.message);
      throw createError('Failed to list feed sources', 500, 'SERVER_ERROR');
    }

    res.json({ sources: data || [] });
  } catch (err) {
    next(err);
  }
});

router.post('/feed-sources', writeLimiter, async (req, res, next) => {
  try {
    const input = validateRequest(createFeedSourceSchema, req.body);

    const { data: source, error } = await supabaseAdmin
      .from('feed_sources')
      .insert({
        name: input.name,
        feed_url: input.feed_url,
        feed_type: input.feed_type,
        poll_interval_hours: input.poll_interval_hours,
        default_location: input.default_location || null,
        default_timezone: input.default_timezone,
        notes: input.notes || null,
      })
      .select('id, name, feed_url, feed_type, status')
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] Create feed source error:', error.message);
      throw createError('Failed to create feed source', 500, 'SERVER_ERROR');
    }

    const adminId = getAdminUserId();
    auditPortalAction('feed_source_created', adminId, source.id as string);
    console.log(`[COMMONS-ADMIN] Created feed source "${input.name}"`);

    res.status(201).json({ source });
  } catch (err) {
    next(err);
  }
});

router.patch('/feed-sources/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const input = validateRequest(updateFeedSourceSchema, req.body);

    const { data: source, error } = await supabaseAdmin
      .from('feed_sources')
      .update(input)
      .eq('id', req.params.id)
      .select('id, name, feed_url, feed_type, poll_interval_hours, status, default_location, default_timezone, notes')
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] Update feed source error:', error.message);
      throw createError('Failed to update feed source', 500, 'SERVER_ERROR');
    }

    const adminId = getAdminUserId();
    auditPortalAction('feed_source_updated', adminId, req.params.id);
    res.json({ source });
  } catch (err) {
    next(err);
  }
});

router.delete('/feed-sources/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');

    // Delete associated candidates first, then the source
    await supabaseAdmin
      .from('event_candidates')
      .delete()
      .eq('feed_source_id', req.params.id);

    const { error } = await supabaseAdmin
      .from('feed_sources')
      .delete()
      .eq('id', req.params.id);

    if (error) {
      console.error('[COMMONS-ADMIN] Delete feed source error:', error.message);
      throw createError('Failed to delete feed source', 500, 'SERVER_ERROR');
    }

    const adminId = getAdminUserId();
    auditPortalAction('feed_source_deleted', adminId, req.params.id);
    console.log(`[COMMONS-ADMIN] Deleted feed source ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/feed-sources/:id/poll', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');

    const { data: source, error: fetchErr } = await supabaseAdmin
      .from('feed_sources')
      .select('id, name, feed_url, feed_type, poll_interval_hours, status, default_location, default_timezone, last_polled_at')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !source) {
      throw createError('Feed source not found', 404, 'NOT_FOUND');
    }

    const result = await pollFeedSource(source as unknown as Parameters<typeof pollFeedSource>[0]);

    const adminId = getAdminUserId();
    auditPortalAction('feed_source_polled', adminId, req.params.id, {
      candidates: result.candidateCount,
      skipped: result.skippedDuplicates,
    });

    res.json({ result });
  } catch (err) {
    next(err);
  }
});

// ─── Event Candidates ───────────────────────────────────────────

router.get('/event-candidates', portalLimiter, async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    let query = supabaseAdmin
      .from('event_candidates')
      .select('id, email_id, source_id, feed_source_id, title, description, start_date, start_time, end_time, location_name, location_address, location_lat, location_lng, source_url, confidence, status, matched_event_id, match_confidence, review_notes, created_at, reviewed_at, candidate_image_url, price, category, tags, newsletter_emails(subject), newsletter_sources(name), feed_sources(name)')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[COMMONS-ADMIN] Event candidates list error:', error.message);
      throw createError('Failed to list event candidates', 500, 'SERVER_ERROR');
    }

    res.json({ candidates: data || [] });
  } catch (err) {
    next(err);
  }
});

// GET /event-candidates/:id — detail with source email body
router.get('/event-candidates/:id', portalLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');

    const { data: candidate, error } = await supabaseAdmin
      .from('event_candidates')
      .select('id, email_id, source_id, feed_source_id, title, description, start_date, start_time, end_time, location_name, location_address, location_lat, location_lng, source_url, confidence, status, matched_event_id, match_confidence, review_notes, created_at, reviewed_at, candidate_image_url, price, category, tags, extraction_metadata, newsletter_emails(subject, body_plain, body_html, sender_email, received_at), newsletter_sources(name), feed_sources(name)')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) {
      console.error('[COMMONS-ADMIN] Event candidate detail error:', error.message);
      throw createError('Failed to fetch candidate', 500, 'SERVER_ERROR');
    }

    if (!candidate) {
      throw createError('Candidate not found', 404, 'NOT_FOUND');
    }

    res.json({ candidate });
  } catch (err) {
    next(err);
  }
});

router.post('/event-candidates/:id/approve', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const overrides = req.body && Object.keys(req.body).length > 0
      ? validateRequest(approveCandidateSchema, req.body)
      : {};

    // Fetch the candidate
    const { data: candidate, error: fetchErr } = await supabaseAdmin
      .from('event_candidates')
      .select('id, title, description, start_date, start_time, end_time, location_name, location_address, location_lat, location_lng, source_url, confidence, status, source_id, feed_source_id, candidate_image_url, price, category, tags, newsletter_sources(name), feed_sources(name)')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !candidate) {
      throw createError('Event candidate not found', 404, 'NOT_FOUND');
    }

    if (candidate.status !== 'pending') {
      throw createError(`Candidate is already ${candidate.status}`, 409, 'CONFLICT');
    }

    // Build event data from candidate + overrides
    const title = overrides.title || (candidate.title as string);
    const description = overrides.description || (candidate.description as string | null);
    const eventDate = overrides.event_date || (candidate.start_date as string | null);
    const startTime = overrides.start_time || (candidate.start_time as string | null);
    const endTime = overrides.end_time || (candidate.end_time as string | null);
    const venueName = overrides.venue_name || (candidate.location_name as string | null);
    const address = overrides.address || (candidate.location_address as string | null);
    const placeId = overrides.place_id || null;
    const lat = overrides.latitude ?? (candidate.location_lat as number | null);
    const lng = overrides.longitude ?? (candidate.location_lng as number | null);
    const category = overrides.category || (candidate.category as string | null) || 'community';
    const candidateTags = Array.isArray(candidate.tags) ? candidate.tags as string[] : [];
    const tags = overrides.tags || (candidateTags.length > 0 ? candidateTags : []);
    const price = overrides.price || (candidate.price as string | null) || null;
    const timezone = overrides.event_timezone || 'America/New_York';

    if (!eventDate) {
      throw createError('Event date is required to approve', 400, 'VALIDATION_ERROR');
    }

    // Build event_at timestamp
    const timeStr = startTime || '12:00';
    const eventAt = toTimestamptz(eventDate, timeStr, timezone);
    const endTimeAt = endTime ? toTimestamptz(eventDate, endTime, timezone) : null;

    // Source publisher from newsletter source name
    const sourceJoin = candidate.newsletter_sources as unknown as { name: string } | null;
    const feedJoin = candidate.feed_sources as unknown as { name: string } | null;
    const sourceName = sourceJoin?.name || feedJoin?.name;

    // Insert the real event
    const { data: event, error: insertErr } = await supabaseAdmin
      .from('events')
      .insert({
        content: title,
        description: description || null,
        event_at: eventAt,
        end_time: endTimeAt,
        event_timezone: timezone,
        place_id: placeId,
        place_name: venueName || null,
        venue_address: address || null,
        latitude: lat,
        longitude: lng,
        category,
        tags: validateTags(tags, category),
        price: price || null,
        link_url: (candidate.source_url as string | null) || null,
        source: 'portal',
        source_method: candidate.feed_source_id ? 'feed' : 'newsletter',
        source_publisher: sourceName || 'community',
        status: 'published',
        visibility: 'public',
        region_id: config.defaultRegionId || null,
        start_time_required: !!startTime,
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('[COMMONS-ADMIN] Event create from candidate error:', insertErr.message);
      throw createError('Failed to create event from candidate', 500, 'SERVER_ERROR');
    }

    const eventId = event.id as string;

    // Update candidate status
    await supabaseAdmin
      .from('event_candidates')
      .update({
        status: 'approved',
        matched_event_id: eventId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);

    // Fire-and-forget: geocode if needed (skip if we already have coordinates from Places)
    if (!lat || !lng) {
      void geocodeEventIfNeeded(eventId, address, null, null, null);
    }

    // Fire-and-forget: download image (if any), then dispatch webhooks
    // Image must finish before webhook so the payload includes the image URL
    const candidateImageUrl = candidate.candidate_image_url as string | null;
    void (async () => {
      if (candidateImageUrl) {
        try {
          await downloadAndAttachImage(eventId, candidateImageUrl);
        } catch (err) {
          console.error('[COMMONS-ADMIN] Candidate image download failed:', err instanceof Error ? err.message : err);
        }
      }
      // Dispatch webhook after image is attached (or if no image)
      const { data: row } = await supabaseAdmin
        .from('events')
        .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name, wheelchair_accessible)`)
        .eq('id', eventId)
        .maybeSingle();
      if (row) {
        void dispatchWebhooks('event.created', eventId, toNeighborhoodEvent(row as unknown as PortalEventRow));
      } else {
        console.error(`[COMMONS-ADMIN] Webhook dispatch: event ${eventId} not found after insert`);
      }
    })().catch((err) => {
      console.error('[COMMONS-ADMIN] Approve webhook pipeline error:', err instanceof Error ? err.message : err);
    });

    const adminId = getAdminUserId();
    auditPortalAction('newsletter_candidate_approved', adminId, eventId, { candidate_id: req.params.id });
    console.log(`[COMMONS-ADMIN] Approved candidate ${req.params.id} → event ${eventId}`);

    res.status(201).json({ event_id: eventId, candidate_id: req.params.id });
  } catch (err) {
    next(err);
  }
});

router.post('/event-candidates/:id/reject', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const input = req.body && Object.keys(req.body).length > 0
      ? validateRequest(rejectCandidateSchema, req.body)
      : {};

    const { data: candidate, error: fetchErr } = await supabaseAdmin
      .from('event_candidates')
      .select('id, status')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !candidate) {
      throw createError('Event candidate not found', 404, 'NOT_FOUND');
    }

    if (candidate.status !== 'pending') {
      throw createError(`Candidate is already ${candidate.status}`, 409, 'CONFLICT');
    }

    await supabaseAdmin
      .from('event_candidates')
      .update({
        status: 'rejected',
        review_notes: input.review_notes || null,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);

    const adminId = getAdminUserId();
    auditPortalAction('newsletter_candidate_rejected', adminId, req.params.id);
    console.log(`[COMMONS-ADMIN] Rejected candidate ${req.params.id}`);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/event-candidates/:id/duplicate', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const input = req.body && Object.keys(req.body).length > 0
      ? validateRequest(duplicateCandidateSchema, req.body)
      : {};

    const { data: candidate, error: fetchErr } = await supabaseAdmin
      .from('event_candidates')
      .select('id, status, matched_event_id')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !candidate) {
      throw createError('Event candidate not found', 404, 'NOT_FOUND');
    }

    if (candidate.status !== 'pending') {
      throw createError(`Candidate is already ${candidate.status}`, 409, 'CONFLICT');
    }

    await supabaseAdmin
      .from('event_candidates')
      .update({
        status: 'duplicate',
        matched_event_id: input.matched_event_id || (candidate.matched_event_id as string | null),
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);

    const adminId = getAdminUserId();
    auditPortalAction('newsletter_candidate_duplicate', adminId, req.params.id);
    console.log(`[COMMONS-ADMIN] Marked candidate ${req.params.id} as duplicate`);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// BATCH APPROVE AS SERIES
// =============================================================================

const batchApproveSeriesSchema = z.object({
  candidate_ids: z.array(z.string().uuid()).min(2).max(100),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  venue_name: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
  place_id: z.string().max(300).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]).default('community'),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).transform(t => t.slice(0, 5)).optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).transform(t => t.slice(0, 5)).optional(),
  price: z.string().max(100).optional(),
  event_timezone: z.string().max(50).default('America/New_York'),
  recurrence: z.string().max(100).default('weekly'),
});

/**
 * Detect a recurrence pattern from a sorted list of date strings.
 * Returns 'weekly', 'biweekly', 'monthly', or 'none'.
 */
function detectRecurrence(dates: string[]): string {
  if (dates.length < 2) return 'none';
  const sorted = [...dates].sort();
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = new Date(sorted[i - 1]!);
    const b = new Date(sorted[i]!);
    gaps.push(Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)));
  }
  const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  if (avg >= 5 && avg <= 9) return 'weekly';
  if (avg >= 12 && avg <= 16) return 'biweekly';
  if (avg >= 25 && avg <= 35) return 'monthly';
  return 'weekly'; // default fallback
}

router.post('/event-candidates/batch-approve', writeLimiter, async (req, res, next) => {
  try {
    const input = validateRequest(batchApproveSeriesSchema, req.body);

    // Fetch all candidates
    const { data: candidates, error: fetchErr } = await supabaseAdmin
      .from('event_candidates')
      .select('id, title, start_date, start_time, end_time, location_name, location_address, location_lat, location_lng, source_url, status, source_id, feed_source_id, candidate_image_url, price, category, tags, newsletter_sources(name), feed_sources(name)')
      .in('id', input.candidate_ids);

    if (fetchErr || !candidates || candidates.length === 0) {
      throw createError('No candidates found', 404, 'NOT_FOUND');
    }

    // Verify all are pending
    const nonPending = candidates.filter(c => c.status !== 'pending');
    if (nonPending.length > 0) {
      throw createError(`${nonPending.length} candidate(s) are not pending`, 409, 'CONFLICT');
    }

    // Sort by date
    const sorted = [...candidates].sort((a, b) =>
      (a.start_date as string || '').localeCompare(b.start_date as string || '')
    );

    const timezone = input.event_timezone;
    const firstCandidate = sorted[0]!;

    // Source info from first candidate
    const sourceJoin = firstCandidate.newsletter_sources as unknown as { name: string } | null;
    const feedJoin = firstCandidate.feed_sources as unknown as { name: string } | null;
    const sourceName = sourceJoin?.name || feedJoin?.name;

    // Auto-detect recurrence from dates if not explicitly set
    const dates = sorted.map(c => c.start_date as string).filter(Boolean);
    const recurrence = input.recurrence === 'weekly' ? detectRecurrence(dates) : input.recurrence;

    const adminUserId = getAdminUserId();

    // Build the template event data
    const templateData: Record<string, unknown> = {
      content: input.title,
      description: input.description || null,
      place_id: input.place_id || null,
      place_name: input.venue_name || null,
      venue_address: input.address || null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      category: input.category,
      price: input.price || null,
      link_url: (firstCandidate.source_url as string | null) || null,
      source: 'portal',
      source_method: firstCandidate.feed_source_id ? 'feed' : 'newsletter',
      source_publisher: sourceName || 'community',
      status: 'published',
      visibility: 'public',
      region_id: config.defaultRegionId || null,
      start_time_required: !!input.start_time,
    };

    // Snapshot for base_event_data
    const baseEventData: Record<string, unknown> = {};
    const templateKeys = [
      'content', 'description', 'place_name', 'venue_address', 'place_id',
      'latitude', 'longitude', 'category', 'price', 'link_url',
      'start_time_required',
    ];
    for (const key of templateKeys) {
      if (key in templateData) baseEventData[key] = templateData[key];
    }

    // Create event_series
    const { data: series, error: seriesErr } = await supabaseAdmin
      .from('event_series')
      .insert({
        creator_account_id: null,
        user_id: adminUserId,
        recurrence,
        recurrence_rule: { frequency: recurrence, count: sorted.length },
        base_event_data: baseEventData,
      })
      .select('id')
      .single();

    if (seriesErr || !series) {
      console.error('[COMMONS-ADMIN] Series create failed:', seriesErr?.message);
      throw createError('Failed to create event series', 500, 'SERVER_ERROR');
    }

    // Build event rows — one per candidate, preserving each candidate's date
    const eventRows = sorted.map((c, i) => {
      const eventDate = c.start_date as string;
      const startTime = input.start_time || (c.start_time as string) || '12:00';
      const endTime = input.end_time || (c.end_time as string) || null;
      const eventAt = toTimestamptz(eventDate, startTime, timezone);
      let endTimeAt: string | null = null;
      if (endTime) {
        endTimeAt = toTimestamptz(eventDate, endTime, timezone);
        if (new Date(endTimeAt) <= new Date(eventAt)) {
          const nextDay = new Date(eventDate);
          nextDay.setDate(nextDay.getDate() + 1);
          endTimeAt = toTimestamptz(nextDay.toISOString().split('T')[0]!, endTime, timezone);
        }
      }

      return {
        ...templateData,
        event_at: eventAt,
        end_time: endTimeAt,
        event_timezone: timezone,
        recurrence,
        series_id: series.id,
        series_instance_number: i + 1,
      };
    });

    const { data: events, error: insertErr } = await supabaseAdmin
      .from('events')
      .insert(eventRows)
      .select('id, event_at')
      .order('event_at', { ascending: true });

    if (insertErr || !events) {
      console.error('[COMMONS-ADMIN] Series events insert failed:', insertErr?.message);
      throw createError('Failed to create series events', 500, 'SERVER_ERROR');
    }

    // Mark all candidates as approved, linking to their respective events
    for (let i = 0; i < sorted.length; i++) {
      await supabaseAdmin
        .from('event_candidates')
        .update({
          status: 'approved',
          matched_event_id: events[i]?.id || null,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', sorted[i]!.id);
    }

    // Fire-and-forget: download image from first candidate that has one
    const imageCandidate = sorted.find(c => c.candidate_image_url);
    const firstEventId = events[0]?.id;
    if (imageCandidate?.candidate_image_url && firstEventId) {
      void (async () => {
        try {
          await downloadAndAttachImage(firstEventId, imageCandidate.candidate_image_url as string);
        } catch (err) {
          console.error('[COMMONS-ADMIN] Series image download failed:', err instanceof Error ? err.message : err);
        }
      })();
    }

    // Fire-and-forget: dispatch webhooks for each event
    void (async () => {
      for (const event of events) {
        const { data: row } = await supabaseAdmin
          .from('events')
          .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name, wheelchair_accessible)`)
          .eq('id', event.id)
          .maybeSingle();
        if (row) {
          void dispatchWebhooks('event.created', event.id, toNeighborhoodEvent(row as unknown as PortalEventRow));
        }
      }
    })().catch((err) => {
      console.error('[COMMONS-ADMIN] Batch approve webhook pipeline error:', err instanceof Error ? err.message : err);
    });

    // Fire-and-forget: geocode if needed
    if (!input.latitude || !input.longitude) {
      void geocodeEventIfNeeded(firstEventId!, input.address || null, null, null, null);
    }

    const adminId = getAdminUserId();
    auditPortalAction('newsletter_candidates_batch_approved', adminId, series.id, {
      candidate_count: sorted.length,
      event_count: events.length,
    });
    console.log(`[COMMONS-ADMIN] Batch approved ${sorted.length} candidates → series ${series.id} with ${events.length} events`);

    res.status(201).json({
      series_id: series.id,
      event_count: events.length,
      events: events.map(e => ({ id: e.id, event_at: e.event_at })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
