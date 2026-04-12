/**
 * Portal CSV Contribution Routes
 *
 * CSV data upload for contributors: upload → preview/map → confirm.
 * Stateful — rows are stored in the DB for admin review and auditability.
 */

import { Router } from 'express';
import { createHash } from 'crypto';
import { z } from 'zod';
import { EVENT_CATEGORY_KEYS } from '../../lib/categories.js';
import { validateTags } from '../../lib/tags.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest, validateUuidParam } from '../../lib/helpers.js';
import { config } from '../../config.js';
import { dispatchWebhooks } from '../../lib/webhook-delivery.js';
import { auditPortalAction } from '../../lib/audit.js';
import { writeLimiter } from '../../middleware/rate-limit.js';
import { toTimestamptz, getAdminUserId } from '../../lib/event-operations.js';
import { sanitizeUrl, checkApprovedDomain } from '../../lib/url-sanitizer.js';
import { getPortalAccount, getAuditActor } from '../../lib/portal-helpers.js';
import {
  parseCSV,
  autoDetectMapping,
  lookupCategoryMappings,
  saveCategoryMappings,
  validateContributionRow,
  parseFlexibleDate,
  parseFlexibleTime,
  MAPPABLE_FIELDS,
} from '../../lib/csv-helpers.js';

const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

const router: ReturnType<typeof Router> = Router();

// =============================================================================
// SCHEMAS
// =============================================================================

const csvUploadSchema = z.object({
  csv_text: z.string().min(1).max(5 * 1024 * 1024), // 5MB text limit
  file_name: z.string().max(255).optional(),
  event_timezone: z.string().max(50).refine(
    (tz) => VALID_TIMEZONES.has(tz),
    { message: 'Invalid timezone' },
  ).default('America/New_York'),
});

const csvPreviewSchema = z.object({
  batch_id: z.string().uuid(),
  column_mapping: z.record(z.string(), z.enum(MAPPABLE_FIELDS as unknown as [string, ...string[]])),
  default_category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]),
  category_column: z.string().optional(),
  category_overrides: z.record(z.string(), z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]])).optional(),
});

const rowOverrideSchema = z.object({
  name: z.string().max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  venue_name: z.string().max(200).optional(),
  category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]).optional(),
  custom_category: z.string().max(50).optional(),
  description: z.string().max(5000).optional(),
  price: z.string().max(100).optional(),
  tags: z.array(z.string().max(50)).max(15).optional(),
});

const csvConfirmSchema = z.object({
  batch_id: z.string().uuid(),
  selected_rows: z.array(z.number().int().min(1)).min(1).max(500),
  row_overrides: z.record(z.string(), rowOverrideSchema).optional(),
  category_proposals: z.array(z.object({
    proposed_name: z.string().max(50),
    justification: z.string().max(500).optional(),
    fallback_category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]),
  })).max(10).optional(),
});

// =============================================================================
// RATE LIMITING
// =============================================================================

const CSV_UPLOAD_RATE_LIMIT = 5; // per hour per account

async function checkCsvRateLimit(accountId: string): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabaseAdmin
    .from('contribution_batches')
    .select('id', { count: 'exact', head: true })
    .eq('contributor_account_id', accountId)
    .gte('created_at', oneHourAgo);

  if ((count || 0) >= CSV_UPLOAD_RATE_LIMIT) {
    throw createError(`Upload limit reached (${CSV_UPLOAD_RATE_LIMIT}/hour). Try again later.`, 429, 'RATE_LIMIT');
  }
}

// =============================================================================
// UPLOAD — Parse CSV, store rows, return mapping suggestions
// =============================================================================

/**
 * POST /api/portal/csv/upload
 * Parse a CSV, create a batch with rows, return auto-detected column mapping.
 */
router.post('/csv/upload', writeLimiter, async (req, res, next) => {
  try {
    const account = await getPortalAccount(req);
    await checkCsvRateLimit(account.id);
    const data = validateRequest(csvUploadSchema, req.body);

    // Parse CSV
    const { headers, rows } = parseCSV(data.csv_text);
    if (headers.length === 0) {
      throw createError('CSV has no headers', 400, 'CSV_INVALID');
    }
    if (rows.length === 0) {
      throw createError('CSV has no data rows', 400, 'CSV_EMPTY');
    }
    if (rows.length > 500) {
      throw createError('CSV exceeds 500 row limit', 400, 'CSV_TOO_LARGE');
    }

    // Auto-detect column mapping
    const suggestedMapping = autoDetectMapping(headers);

    // Hash file for dedup detection
    const fileHash = createHash('sha256').update(data.csv_text).digest('hex');

    // Create batch
    const { data: batch, error: batchError } = await supabaseAdmin
      .from('contribution_batches')
      .insert({
        contributor_account_id: account.id,
        status: 'draft',
        file_name: data.file_name || null,
        file_hash: fileHash,
        event_timezone: data.event_timezone,
        column_mapping: suggestedMapping,
        total_rows: rows.length,
      })
      .select('id')
      .single();

    if (batchError || !batch) {
      throw createError('Failed to create contribution batch', 500, 'INTERNAL_ERROR');
    }

    // Insert rows
    const rowInserts = rows.map((row, i) => ({
      batch_id: batch.id,
      row_number: i + 1,
      raw_data: row,
      status: 'pending',
    }));

    const { error: rowError } = await supabaseAdmin
      .from('contribution_rows')
      .insert(rowInserts);

    if (rowError) {
      // Clean up batch if row insert fails
      await supabaseAdmin.from('contribution_batches').delete().eq('id', batch.id);
      throw createError('Failed to store CSV rows', 500, 'INTERNAL_ERROR');
    }

    console.log(`[CSV] Upload: ${rows.length} rows from "${data.file_name || 'unnamed'}" by account ${account.id.slice(0, 8)}...`);

    res.status(201).json({
      batch_id: batch.id,
      headers,
      row_count: rows.length,
      sample_rows: rows.slice(0, 5),
      suggested_mapping: suggestedMapping,
    });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// PREVIEW — Apply mapping, validate, return preview with category resolution
// =============================================================================

/**
 * POST /api/portal/csv/preview
 * Apply column mapping and category resolution to batch rows.
 * Returns preview of valid/error rows and any unmapped categories.
 */
router.post('/csv/preview', writeLimiter, async (req, res, next) => {
  try {
    const account = await getPortalAccount(req);
    const data = validateRequest(csvPreviewSchema, req.body);

    // Fetch batch — verify ownership
    const { data: batch, error: batchError } = await supabaseAdmin
      .from('contribution_batches')
      .select('id, contributor_account_id, status')
      .eq('id', data.batch_id)
      .single();

    if (batchError || !batch) {
      throw createError('Batch not found', 404, 'NOT_FOUND');
    }
    if (batch.contributor_account_id !== account.id) {
      throw createError('Batch not found', 404, 'NOT_FOUND');
    }
    if (batch.status !== 'draft') {
      throw createError('Batch has already been submitted', 400, 'BATCH_ALREADY_SUBMITTED');
    }

    // Fetch all rows
    const { data: rows, error: rowError } = await supabaseAdmin
      .from('contribution_rows')
      .select('id, row_number, raw_data')
      .eq('batch_id', data.batch_id)
      .order('row_number', { ascending: true });

    if (rowError || !rows) {
      throw createError('Failed to fetch batch rows', 500, 'INTERNAL_ERROR');
    }

    // Collect unique category terms for batch lookup
    const categoryTerms = new Set<string>();
    const categoryColumn = data.category_column || null;

    // Apply mapping and validate each row
    const validRows: Array<{ row_number: number; mapped: Record<string, string>; category: string }> = [];
    const errorRows: Array<{ row_number: number; errors: Array<{ field: string; message: string }> }> = [];

    for (const row of rows) {
      const raw = row.raw_data as Record<string, string>;
      const mapped: Record<string, string> = {};

      // Apply column mapping
      for (const [csvHeader, dbField] of Object.entries(data.column_mapping)) {
        const value = raw[csvHeader];
        if (value !== undefined && value !== '') {
          mapped[dbField] = value;
        }
      }

      // Resolve category
      let categoryTerm: string | null = null;
      let resolvedCategory = data.default_category;

      if (categoryColumn && raw[categoryColumn]) {
        categoryTerm = raw[categoryColumn]!.trim();
        // Check contributor overrides first
        if (data.category_overrides && data.category_overrides[categoryTerm]) {
          resolvedCategory = data.category_overrides[categoryTerm]!;
        } else {
          categoryTerms.add(categoryTerm);
        }
      }

      // Validate
      const errors = validateContributionRow(mapped, resolvedCategory);

      // Update row in DB
      await supabaseAdmin
        .from('contribution_rows')
        .update({
          mapped_data: mapped,
          category_source_term: categoryTerm,
          category_mapped_to: resolvedCategory,
          validation_errors: errors,
          status: errors.length > 0 ? 'error' : 'valid',
        })
        .eq('id', row.id);

      if (errors.length > 0) {
        errorRows.push({ row_number: row.row_number, errors });
      } else {
        validRows.push({ row_number: row.row_number, mapped, category: resolvedCategory });
      }
    }

    // Look up category mappings for unresolved terms
    let unmappedCategories: string[] = [];
    let categoryMappingResults: Record<string, string> = {};
    if (categoryTerms.size > 0) {
      const result = await lookupCategoryMappings([...categoryTerms]);
      unmappedCategories = result.unmapped;
      categoryMappingResults = result.mapped;

      // Update rows that got category mappings from the shared table
      for (const row of rows) {
        const raw = row.raw_data as Record<string, string>;
        if (categoryColumn && raw[categoryColumn]) {
          const term = raw[categoryColumn]!.trim();
          if (categoryMappingResults[term]) {
            await supabaseAdmin
              .from('contribution_rows')
              .update({ category_mapped_to: categoryMappingResults[term] })
              .eq('id', row.id);

            // Update our in-memory valid rows too
            const vr = validRows.find(v => v.row_number === row.row_number);
            if (vr) vr.category = categoryMappingResults[term]!;
          }
        }
      }
    }

    // Update batch stats
    await supabaseAdmin
      .from('contribution_batches')
      .update({
        column_mapping: data.column_mapping,
        valid_rows: validRows.length,
        error_rows: errorRows.length,
        updated_at: new Date().toISOString(),
      })
      .eq('id', data.batch_id);

    console.log(`[CSV] Preview: ${validRows.length} valid, ${errorRows.length} errors, ${unmappedCategories.length} unmapped categories`);

    res.json({
      batch_id: data.batch_id,
      valid_rows: validRows.map(r => ({
        row_number: r.row_number,
        name: r.mapped['name'] || '',
        date: r.mapped['date'] || r.mapped['start'] || '',
        start_time: r.mapped['start_time'] || null,
        end_time: r.mapped['end_time'] || null,
        venue_name: r.mapped['venue_name'] || null,
        category: r.category,
        description: r.mapped['description']?.slice(0, 200) || null,
        price: r.mapped['price'] || null,
        tags: [],
      })),
      error_rows: errorRows,
      unmapped_categories: unmappedCategories,
      category_mappings: categoryMappingResults,
      total_valid: validRows.length,
      total_errors: errorRows.length,
    });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// CONFIRM — Create events from selected valid rows
// =============================================================================

/**
 * POST /api/portal/csv/confirm
 * Create events from selected valid rows. Batch status → 'submitted'.
 */
router.post('/csv/confirm', writeLimiter, async (req, res, next) => {
  try {
    const account = await getPortalAccount(req);
    const data = validateRequest(csvConfirmSchema, req.body);
    const adminUserId = getAdminUserId();

    // Fetch contributor profile for attribution
    const { data: accountProfile } = await supabaseAdmin
      .from('portal_accounts')
      .select('business_name, website')
      .eq('id', account.id)
      .single();

    // Fetch batch — verify ownership
    const { data: batch, error: batchError } = await supabaseAdmin
      .from('contribution_batches')
      .select('id, contributor_account_id, status, event_timezone')
      .eq('id', data.batch_id)
      .single();

    if (batchError || !batch) {
      throw createError('Batch not found', 404, 'NOT_FOUND');
    }
    if (batch.contributor_account_id !== account.id) {
      throw createError('Batch not found', 404, 'NOT_FOUND');
    }
    if (batch.status !== 'draft') {
      throw createError('Batch has already been submitted', 400, 'BATCH_ALREADY_SUBMITTED');
    }

    const batchTimezone = (batch.event_timezone as string) || 'America/New_York';

    // Fetch selected valid rows
    const { data: rows, error: rowError } = await supabaseAdmin
      .from('contribution_rows')
      .select('id, row_number, mapped_data, category_mapped_to, category_source_term')
      .eq('batch_id', data.batch_id)
      .eq('status', 'valid')
      .in('row_number', data.selected_rows);

    if (rowError || !rows) {
      throw createError('Failed to fetch rows', 500, 'INTERNAL_ERROR');
    }

    if (rows.length === 0) {
      throw createError('No valid rows found for the selected row numbers', 400, 'NO_VALID_ROWS');
    }

    const eventStatus = account.status === 'active' ? 'published' : 'pending_review';
    const created: Array<{ id: string; name: string; row_number: number; status: string }> = [];
    const skipped: Array<{ row_number: number; name: string; reason: string }> = [];

    // Collect new category mappings from contributor overrides
    const newCategoryMappings: Record<string, string> = {};

    for (const row of rows) {
      const mapped = row.mapped_data as Record<string, string>;
      const override = data.row_overrides?.[String(row.row_number)];
      const category = override?.category || (row.category_mapped_to as string);
      const name = override?.name || mapped['name'] || 'Untitled';

      // Parse date and time — overrides take precedence (already in YYYY-MM-DD / HH:MM)
      let eventDate: string | null = null;
      let startTime: string | null = null;
      let endTimeStr: string | null = null;

      if (override?.date) {
        eventDate = override.date;
        startTime = override.start_time || parseFlexibleTime(mapped['start_time'] || '') || '12:00';
      } else if (mapped['start']) {
        const d = new Date(mapped['start']);
        if (isNaN(d.getTime())) {
          skipped.push({ row_number: row.row_number, name, reason: 'Invalid start datetime' });
          continue;
        }
        eventDate = d.toLocaleDateString('en-CA', { timeZone: batchTimezone });
        startTime = override?.start_time || d.toLocaleTimeString('en-GB', { timeZone: batchTimezone, hour: '2-digit', minute: '2-digit', hour12: false });
      } else {
        eventDate = parseFlexibleDate(mapped['date'] || '');
        if (!eventDate) {
          skipped.push({ row_number: row.row_number, name, reason: 'Could not parse date' });
          continue;
        }
        startTime = override?.start_time || parseFlexibleTime(mapped['start_time'] || '') || '12:00';
      }

      if (override?.end_time !== undefined) {
        endTimeStr = override.end_time;
      } else if (mapped['end_time']) {
        endTimeStr = parseFlexibleTime(mapped['end_time']) || null;
      } else if (mapped['end']) {
        const d = new Date(mapped['end']);
        if (!isNaN(d.getTime())) {
          endTimeStr = d.toLocaleTimeString('en-GB', { timeZone: batchTimezone, hour: '2-digit', minute: '2-digit', hour12: false });
        }
      }
      const eventAt = toTimestamptz(eventDate, startTime, batchTimezone);
      let endTime: string | null = null;
      if (endTimeStr) {
        endTime = toTimestamptz(eventDate, endTimeStr, batchTimezone);
        if (new Date(endTime) <= new Date(eventAt)) {
          const nextDay = new Date(eventDate);
          nextDay.setDate(nextDay.getDate() + 1);
          const nextDateStr = nextDay.toISOString().split('T')[0]!;
          endTime = toTimestamptz(nextDateStr, endTimeStr, batchTimezone);
        }
      }

      const lat = mapped['latitude'] ? parseFloat(mapped['latitude']) : null;
      const lng = mapped['longitude'] ? parseFloat(mapped['longitude']) : null;

      // Validate tags if overridden
      const eventTags = override?.tags ? validateTags(override.tags, category) : [];

      const insertData = {
        user_id: adminUserId,
        content: name.slice(0, 200),
        description: (override?.description ?? mapped['description'] ?? '').slice(0, 5000) || null,
        place_name: (override?.venue_name ?? mapped['venue_name'] ?? 'TBA').slice(0, 200),
        venue_address: (mapped['address'] || '').slice(0, 500) || null,
        place_id: null,
        approximate_location: lat != null && lng != null ? `POINT(${lng} ${lat})` : null,
        latitude: lat,
        longitude: lng,
        event_at: eventAt,
        end_time: endTime,
        event_timezone: batchTimezone,
        category,
        custom_category: override?.custom_category || null,
        recurrence: 'none',
        price: (override?.price ?? mapped['price'] ?? '').slice(0, 100) || null,
        link_url: mapped['ticket_url'] ? (() => { try { checkApprovedDomain(mapped['ticket_url']!); return sanitizeUrl(mapped['ticket_url']!).slice(0, 2000); } catch { return null; } })() : null,
        start_time_required: true,
        tags: eventTags,
        wheelchair_accessible: null,
        rsvp_limit: null,
        event_image_focal_y: 0.5,
        event_image_url: (mapped['image_url'] || '').slice(0, 2000) || null,
        creator_account_id: account.id,
        source: 'csv',
        source_method: 'csv',
        source_publisher: accountProfile?.business_name || null,
        source_contributor_url: accountProfile?.website || null,
        visibility: 'public',
        status: eventStatus,
        is_business: true,
        region_id: config.defaultRegionId,
      };

      const { data: eventRow, error: eventError } = await supabaseAdmin
        .from('events')
        .insert(insertData)
        .select('id, status')
        .single();

      if (eventError) {
        console.error('[CSV] Event insert error:', eventError.message);
        skipped.push({ row_number: row.row_number, name, reason: 'Database error' });
        continue;
      }

      // Update contribution row with created event reference
      await supabaseAdmin
        .from('contribution_rows')
        .update({ status: 'created', created_event_id: eventRow.id })
        .eq('id', row.id);

      created.push({ id: eventRow.id, name, row_number: row.row_number, status: eventRow.status });

      // Track category mapping if the contributor resolved it
      if (row.category_source_term && row.category_mapped_to) {
        newCategoryMappings[row.category_source_term as string] = row.category_mapped_to as string;
      }

      // Dispatch webhook for published events
      if (eventRow.status === 'published') {
        void dispatchWebhooks('event.created', eventRow.id, {
          id: eventRow.id,
          name,
          start: eventAt,
        } as unknown as import('../../lib/event-transform.js').NeighborhoodEvent);
      }
    }

    // Save any new category mappings contributed by the user
    if (Object.keys(newCategoryMappings).length > 0) {
      await saveCategoryMappings(newCategoryMappings, account.id);
    }

    // Store category proposals for admin review
    if (data.category_proposals && data.category_proposals.length > 0) {
      for (const proposal of data.category_proposals) {
        await supabaseAdmin
          .from('category_proposals')
          .insert({
            proposed_name: proposal.proposed_name,
            justification: proposal.justification || null,
            fallback_category: proposal.fallback_category,
            contributor_account_id: account.id,
            batch_id: data.batch_id,
          });
      }
      console.log(`[CSV] ${data.category_proposals.length} category proposal(s) stored for review`);
    }

    // Update batch status and stats
    await supabaseAdmin
      .from('contribution_batches')
      .update({
        status: 'submitted',
        created_events: created.length,
        updated_at: new Date().toISOString(),
      })
      .eq('id', data.batch_id);

    console.log(`[CSV] Confirmed: ${created.length} created, ${skipped.length} skipped from batch ${data.batch_id.slice(0, 8)}...`);
    const { actor, impersonationMeta } = getAuditActor(req, account.id);
    auditPortalAction('csv_contribution', actor, account.id, {
      batch_id: data.batch_id,
      created: created.length,
      skipped: skipped.length,
      ...impersonationMeta,
    });

    res.status(201).json({
      created,
      skipped,
      total_created: created.length,
      total_skipped: skipped.length,
    });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// POPULAR TAGS — Usage counts for tag alignment
// =============================================================================

let popularTagsCache: { data: Array<{ slug: string; label: string; count: number }>; fetchedAt: number } = { data: [], fetchedAt: 0 };
const POPULAR_TAGS_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * GET /api/portal/tags/popular
 * Returns tags used on published events in the last 90 days, with usage counts.
 * Cached for 1 hour to avoid repeated aggregate queries.
 */
router.get('/tags/popular', async (_req, res, next) => {
  try {
    if (Date.now() - popularTagsCache.fetchedAt < POPULAR_TAGS_TTL_MS) {
      res.json({ tags: popularTagsCache.data });
      return;
    }

    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: rows, error } = await supabaseAdmin.rpc('get_popular_tags' as never, { since: ninetyDaysAgo } as never);

    if (error) {
      // Fallback: return empty if the RPC doesn't exist yet
      console.warn('[TAGS] Popular tags query failed:', error.message);
      res.json({ tags: [] });
      return;
    }

    const tags = ((rows as Array<{ tag: string; count: number }>) || []).map(r => ({
      slug: r.tag,
      label: r.tag.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      count: Number(r.count),
    }));

    popularTagsCache = { data: tags, fetchedAt: Date.now() };
    res.json({ tags });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// BATCH HISTORY — List and detail endpoints
// =============================================================================

/**
 * GET /api/portal/csv/batches
 * List contribution batches for the authenticated account.
 */
router.get('/csv/batches', async (req, res, next) => {
  try {
    const account = await getPortalAccount(req);

    const { data: batches, error } = await supabaseAdmin
      .from('contribution_batches')
      .select('id, status, file_name, total_rows, valid_rows, error_rows, created_events, created_at, updated_at')
      .eq('contributor_account_id', account.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      throw createError('Failed to fetch batches', 500, 'INTERNAL_ERROR');
    }

    res.json({ batches: batches || [] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/portal/csv/batches/:id
 * Fetch batch detail with row-level status.
 */
router.get('/csv/batches/:id', async (req, res, next) => {
  try {
    const account = await getPortalAccount(req);
    validateUuidParam(req.params.id, 'batch id');
    const batchId = req.params.id;

    const { data: batch, error: batchError } = await supabaseAdmin
      .from('contribution_batches')
      .select('*')
      .eq('id', batchId)
      .single();

    if (batchError || !batch) {
      throw createError('Batch not found', 404, 'NOT_FOUND');
    }
    if (batch.contributor_account_id !== account.id) {
      throw createError('Batch not found', 404, 'NOT_FOUND');
    }

    const { data: rows, error: rowError } = await supabaseAdmin
      .from('contribution_rows')
      .select('id, row_number, raw_data, mapped_data, category_source_term, category_mapped_to, validation_errors, status, created_event_id')
      .eq('batch_id', batchId)
      .order('row_number', { ascending: true });

    if (rowError) {
      throw createError('Failed to fetch rows', 500, 'INTERNAL_ERROR');
    }

    res.json({
      batch,
      rows: rows || [],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/portal/csv/batches/:id
 * Delete a batch and all events it created.
 * Contributor can undo their own uploads — they're the authority on their data.
 */
router.delete('/csv/batches/:id', writeLimiter, async (req, res, next) => {
  try {
    const account = await getPortalAccount(req);
    validateUuidParam(req.params.id, 'batch id');
    const batchId = req.params.id;

    // Verify ownership
    const { data: batch, error: batchError } = await supabaseAdmin
      .from('contribution_batches')
      .select('id, contributor_account_id, created_events')
      .eq('id', batchId)
      .single();

    if (batchError || !batch) {
      throw createError('Batch not found', 404, 'NOT_FOUND');
    }
    if (batch.contributor_account_id !== account.id) {
      throw createError('Batch not found', 404, 'NOT_FOUND');
    }

    // Find all events created by this batch
    const { data: rows } = await supabaseAdmin
      .from('contribution_rows')
      .select('created_event_id')
      .eq('batch_id', batchId)
      .not('created_event_id', 'is', null);

    const eventIds = (rows || []).map(r => r.created_event_id).filter(Boolean) as string[];

    // Delete the events (cascade from contribution_rows.created_event_id is SET NULL,
    // so we delete events explicitly first)
    if (eventIds.length > 0) {
      const { error: deleteError } = await supabaseAdmin
        .from('events')
        .delete()
        .in('id', eventIds);

      if (deleteError) {
        console.error('[CSV] Batch event deletion error:', deleteError.message);
        throw createError('Failed to delete batch events', 500, 'INTERNAL_ERROR');
      }

      // Dispatch webhooks for deleted events (fire-and-forget)
      for (const eventId of eventIds) {
        void dispatchWebhooks('event.deleted', eventId, {
          id: eventId, name: '', start: '', end: null, timezone: 'UTC', description: null,
          category: [], place_id: null,
          location: { name: '', address: null, lat: null, lng: null },
          url: null, images: [], event_image_focal_y: 0.5, organizer: { name: '', phone: null },
          cost: null, series_id: null, series_instance_number: null, series_instance_count: null,
          start_time_required: true, tags: [], wheelchair_accessible: null,
          runtime_minutes: null, content_rating: null, showtimes: null, first_party: false, recurrence: null,
          source: { publisher: 'neighborhood-commons', collected_at: new Date().toISOString(), method: 'portal', contributor: null, license: 'CC BY 4.0' },
        });
      }
    }

    // Delete the batch (cascades to contribution_rows)
    const { error: batchDeleteError } = await supabaseAdmin
      .from('contribution_batches')
      .delete()
      .eq('id', batchId);

    if (batchDeleteError) {
      console.error('[CSV] Batch deletion error:', batchDeleteError.message);
      throw createError('Failed to delete batch', 500, 'INTERNAL_ERROR');
    }

    const { actor, impersonationMeta } = getAuditActor(req, account.id);
    auditPortalAction('contribution_batch_deleted', actor, batchId, {
      events_deleted: eventIds.length,
      ...impersonationMeta,
    });

    console.log(`[CSV] Batch ${batchId} deleted: ${eventIds.length} events removed`);
    res.json({ success: true, events_deleted: eventIds.length });
  } catch (err) {
    next(err);
  }
});

export default router;
