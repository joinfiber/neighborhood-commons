/**
 * Ingest Routes — Neighborhood Commons
 *
 * Mailgun inbound email webhook receiver for newsletter event extraction.
 * Validates Mailgun HMAC signature, stores email, and triggers async
 * LLM extraction + geocoding + dedup.
 */

import { Router } from 'express';
import crypto from 'crypto';
import express from 'express';

import { config } from '../config.js';
import { writeLimiter } from '../middleware/rate-limit.js';
import { supabaseAdmin } from '../lib/supabase.js';
import {
  extractEventsFromEmail,
  geocodeCandidate,
  findDuplicate,
  fetchImagesForCandidates,
} from '../lib/newsletter-extraction.js';
import { classifyCandidates } from '../lib/candidate-classification.js';

const router = Router();

// Mailgun sends inbound emails as URL-encoded form data, not JSON
router.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ---------------------------------------------------------------------------
// Mailgun HMAC signature validation
// ---------------------------------------------------------------------------

function validateMailgunSignature(
  timestamp: string,
  token: string,
  signature: string,
): boolean {
  if (!config.mailgunWebhook.signingKey) {
    console.error('[NEWSLETTER] Mailgun signing key not configured');
    return false;
  }

  const hmac = crypto.createHmac('sha256', config.mailgunWebhook.signingKey);
  hmac.update(timestamp + token);
  const expected = hmac.digest('hex');

  // Timing-safe comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /api/ingest/email — Mailgun inbound webhook
// ---------------------------------------------------------------------------

router.post('/email', writeLimiter, async (req, res, next) => {
  try {
    // Validate Mailgun signature
    const { timestamp, token, signature } = req.body;
    if (!timestamp || !token || !signature) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing signature fields' } });
      return;
    }

    if (!validateMailgunSignature(timestamp, token, signature)) {
      console.error('[NEWSLETTER] Invalid Mailgun signature');
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid signature' } });
      return;
    }

    const senderEmail = (req.body.sender || req.body.from || '').trim().toLowerCase();
    const subject = req.body.subject || '(no subject)';
    const messageId = req.body['Message-Id'] || req.body['message-id'] || null;
    const bodyHtml = req.body['body-html'] || null;
    const bodyPlain = req.body['body-plain'] || null;

    if (!senderEmail) {
      // Accept but ignore — Mailgun should always provide a sender
      console.log('[NEWSLETTER] Received email with no sender, ignoring');
      res.status(200).json({ received: true });
      return;
    }

    // Extract just the email address from "Name <email>" format (needed for dedup + source matching)
    const emailMatch = senderEmail.match(/<([^>]+)>/) || [null, senderEmail];
    const cleanSender = (emailMatch[1] || senderEmail).toLowerCase().trim();

    // Dedup: check if we already have this email.
    // Primary key: message_id when available. Fallback: composite of sender + subject + date
    // to catch duplicates when Mailgun omits Message-Id (NULL != NULL in SQL).
    if (messageId) {
      const { data: existing } = await supabaseAdmin
        .from('newsletter_emails')
        .select('id')
        .eq('message_id', messageId)
        .maybeSingle();

      if (existing) {
        console.log(`[NEWSLETTER] Duplicate message_id, skipping: ${messageId}`);
        res.status(200).json({ received: true, duplicate: true });
        return;
      }
    } else {
      // No Message-Id: dedup by sender + subject + recent window (same day)
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const { data: existing } = await supabaseAdmin
        .from('newsletter_emails')
        .select('id')
        .eq('sender_email', cleanSender)
        .eq('subject', subject)
        .gte('created_at', todayStart.toISOString())
        .is('message_id', null)
        .maybeSingle();

      if (existing) {
        console.log(`[NEWSLETTER] Duplicate email (no message_id, same sender+subject today), skipping`);
        res.status(200).json({ received: true, duplicate: true });
        return;
      }
    }

    // Match sender to a known newsletter source

    const { data: source } = await supabaseAdmin
      .from('newsletter_sources')
      .select('id, name, status')
      .eq('sender_email', cleanSender)
      .eq('status', 'active')
      .maybeSingle();

    // Store the email regardless of whether we recognize the sender
    const { data: email, error: insertError } = await supabaseAdmin
      .from('newsletter_emails')
      .insert({
        source_id: source?.id || null,
        message_id: messageId,
        sender_email: cleanSender,
        subject,
        body_html: bodyHtml,
        body_plain: bodyPlain,
        processing_status: source ? 'pending' : 'completed', // Only process known sources
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('[NEWSLETTER] Failed to store email:', insertError.message);
      // Return 200 so Mailgun doesn't retry — we logged the error
      res.status(200).json({ received: true, stored: false });
      return;
    }

    // Update source last_received_at
    if (source) {
      void supabaseAdmin
        .from('newsletter_sources')
        .update({ last_received_at: new Date().toISOString() })
        .eq('id', source.id)
        .then(({ error }) => {
          if (error) console.error('[NEWSLETTER] Failed to update source last_received_at:', error.message);
        });
    }

    const emailId = email.id as string;
    const sourceName = source ? (source.name as string) : 'unknown';
    console.log(`[NEWSLETTER] Stored email ${emailId} from ${cleanSender} (source: ${sourceName})`);

    // Return 200 immediately — Mailgun has a timeout
    res.status(200).json({ received: true, email_id: emailId });

    // Fire-and-forget: process the email if from a known source
    if (source) {
      void processEmail(emailId).catch((err) => {
        console.error('[NEWSLETTER] Processing error for email', emailId, ':', err instanceof Error ? err.message : err);
      });
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Async email processing pipeline
// ---------------------------------------------------------------------------

async function processEmail(emailId: string): Promise<void> {
  // Fetch the email
  const { data: email, error: fetchError } = await supabaseAdmin
    .from('newsletter_emails')
    .select('id, source_id, body_html, body_plain')
    .eq('id', emailId)
    .single();

  if (fetchError || !email) {
    console.error('[NEWSLETTER] Failed to fetch email for processing:', fetchError?.message);
    return;
  }

  // Mark as processing
  await supabaseAdmin
    .from('newsletter_emails')
    .update({ processing_status: 'processing' })
    .eq('id', emailId);

  try {
    // Extract events via LLM
    const bodyHtml = email.body_html as string | null;
    const bodyPlain = email.body_plain as string | null;
    console.log(`[NEWSLETTER] Processing email ${emailId}: html=${!!bodyHtml} (${bodyHtml?.length ?? 0} chars), plain=${!!bodyPlain} (${bodyPlain?.length ?? 0} chars)`);

    const { events, rawResponse } = await extractEventsFromEmail(bodyHtml, bodyPlain);

    console.log(`[NEWSLETTER] LLM returned ${events.length} events, raw response length: ${rawResponse.length}`);
    if (rawResponse.length < 2000) {
      console.log(`[NEWSLETTER] Raw LLM response: ${rawResponse}`);
    }

    // Store raw LLM response for debugging
    await supabaseAdmin
      .from('newsletter_emails')
      .update({ llm_response: rawResponse })
      .eq('id', emailId);

    // Process each extracted event
    let candidateCount = 0;
    const insertedCandidates: Array<{ id: string; source_url: string | null; title: string; description: string | null; price: string | null }> = [];

    for (const event of events) {
      // Geocode location
      const coords = await geocodeCandidate(event.location_name, event.location_address);

      // Dedup check
      const dedup = await findDuplicate({
        title: event.title,
        start_date: event.start_date,
        location_lat: coords?.lat || null,
        location_lng: coords?.lng || null,
      });

      // Insert candidate
      const { data: inserted, error: candidateError } = await supabaseAdmin
        .from('event_candidates')
        .insert({
          email_id: emailId,
          source_id: email.source_id,
          title: event.title,
          description: event.description,
          start_date: event.start_date,
          start_time: event.start_time,
          end_time: event.end_time,
          location_name: event.location_name,
          location_address: event.location_address,
          location_lat: coords?.lat || null,
          location_lng: coords?.lng || null,
          source_url: event.source_url,
          confidence: event.confidence,
          matched_event_id: dedup.matched_event_id,
          match_confidence: dedup.match_confidence > 0 ? dedup.match_confidence : null,
          extraction_metadata: event.extraction_metadata,
        })
        .select('id')
        .single();

      if (candidateError) {
        console.error('[NEWSLETTER] Failed to insert candidate:', candidateError.message);
      } else {
        candidateCount++;
        insertedCandidates.push({ id: inserted.id as string, source_url: event.source_url, title: event.title, description: event.description, price: null });
      }
    }

    // Fetch images from source URLs (best-effort, parallel)
    if (insertedCandidates.some(c => c.source_url)) {
      void fetchAndUpdateCandidateImages(insertedCandidates).catch((err) => {
        console.error('[NEWSLETTER] Image fetch error:', err instanceof Error ? err.message : err);
      });
    }

    // Fire-and-forget: classify candidates via LLM (category + tags)
    if (insertedCandidates.length > 0) {
      void classifyCandidates(insertedCandidates).catch(err => {
        console.error('[NEWSLETTER] Classification error:', err instanceof Error ? err.message : err);
      });
    }

    // Mark email as completed
    await supabaseAdmin
      .from('newsletter_emails')
      .update({
        processing_status: 'completed',
        candidate_count: candidateCount,
      })
      .eq('id', emailId);

    console.log(`[NEWSLETTER] Processed email ${emailId}: ${candidateCount} candidates extracted`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[NEWSLETTER] Processing failed for email', emailId, ':', errorMsg);

    await supabaseAdmin
      .from('newsletter_emails')
      .update({
        processing_status: 'failed',
        processing_error: errorMsg,
      })
      .eq('id', emailId);
  }
}

/**
 * Fetch og:image from each candidate's source URL and update the row.
 * Fire-and-forget — failures are logged but don't block processing.
 */
async function fetchAndUpdateCandidateImages(
  candidates: Array<{ id: string; source_url: string | null }>,
): Promise<void> {
  const imageMap = await fetchImagesForCandidates(candidates);
  if (imageMap.size === 0) return;

  for (const candidate of candidates) {
    if (!candidate.source_url) continue;
    const imageUrl = imageMap.get(candidate.source_url);
    if (!imageUrl) continue;

    await supabaseAdmin
      .from('event_candidates')
      .update({ candidate_image_url: imageUrl })
      .eq('id', candidate.id);
  }

  console.log(`[NEWSLETTER] Updated ${imageMap.size} candidates with images`);
}

export default router;
