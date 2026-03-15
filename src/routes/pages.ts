/**
 * Public Pages — Neighborhood Commons
 *
 * Server-rendered HTML pages for events, venues, and regions.
 * Zero JavaScript required. SEO-friendly with structured data,
 * Open Graph tags, and add-to-calendar links.
 *
 * Routes:
 *   GET /events/:id       — Single event page
 *   GET /venues/:slug     — Venue page with upcoming events
 *   GET /venues/:slug/events.ics — Per-venue iCal feed
 */

import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { config } from '../config.js';
import { EVENT_CATEGORIES } from '../lib/categories.js';
import type { EventCategory } from '../lib/categories.js';
import { toIso } from '../lib/event-transform.js';
import { resolveEventImageUrl } from '../lib/helpers.js';
// Rate limited by global limiter in app.ts — no per-route limiter needed

const router: ReturnType<typeof Router> = Router();

// =============================================================================
// CONSTANTS
// =============================================================================

const SITE_NAME = 'Neighborhood Commons';
const SITE_DOMAIN = config.apiBaseUrl || 'https://commons.joinfiber.app';

const EVENTS_SELECT = 'id, content, description, place_name, venue_address, place_id, latitude, longitude, event_at, end_time, event_timezone, category, custom_category, recurrence, price, link_url, event_image_url, created_at, creator_account_id, series_id, series_instance_number, start_time_required, tags, wheelchair_accessible, source_method, source_publisher, portal_accounts!events_creator_account_id_fkey(business_name, wheelchair_accessible)';

// =============================================================================
// HTML HELPERS
// =============================================================================

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}

/** Format a date for display: "Saturday, March 15, 2026" */
function formatDate(isoDate: string, timezone: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleDateString('en-US', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return isoDate;
  }
}

/** Format time: "7:00 PM" */
function formatTime(isoDate: string, timezone: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleTimeString('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}

/** Short date: "Mar 15" */
function formatShortDate(isoDate: string, timezone: string): { month: string; day: string } {
  try {
    const d = new Date(isoDate);
    return {
      month: d.toLocaleDateString('en-US', { timeZone: timezone, month: 'short' }).toUpperCase(),
      day: d.toLocaleDateString('en-US', { timeZone: timezone, day: 'numeric' }),
    };
  } catch {
    return { month: '???', day: '?' };
  }
}

/** Get category info */
function getCategoryInfo(category: string): { label: string; color: string } {
  const cat = EVENT_CATEGORIES[category as EventCategory];
  return cat || { label: category, color: '#6B7280' };
}

/** Build a time range string: "7:00 PM - 10:00 PM" */
function formatTimeRange(startIso: string, endIso: string | null, timezone: string): string {
  const start = formatTime(startIso, timezone);
  if (!endIso) return start;
  const end = formatTime(endIso, timezone);
  return `${start} \u2013 ${end}`;
}

/** Build Google Calendar "Add to Calendar" link */
function googleCalendarUrl(name: string, start: string, end: string | null, location: string, description: string): string {
  const fmt = (iso: string) => {
    try {
      return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    } catch {
      return '';
    }
  };
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: name,
    dates: `${fmt(start)}/${end ? fmt(end) : fmt(start)}`,
    location,
    details: description.slice(0, 500),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Single-event .ics download content */
function singleEventIcs(event: Record<string, unknown>): string {
  const fmtDt = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    } catch {
      return '';
    }
  };
  const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Neighborhood Commons//Events//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.id}@commons.joinfiber.app`,
    `DTSTART:${fmtDt(event.event_at as string)}`,
  ];
  if (event.end_time) lines.push(`DTEND:${fmtDt(event.end_time as string)}`);
  lines.push(`SUMMARY:${esc(event.content as string)}`);
  if (event.description) lines.push(`DESCRIPTION:${esc(event.description as string)}`);
  if (event.place_name) {
    const loc = (event.place_name as string) + ((event.venue_address as string | null) ? ', ' + event.venue_address : '');
    lines.push(`LOCATION:${esc(loc)}`);
  }
  if (event.link_url) lines.push(`URL:${event.link_url}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

// =============================================================================
// SVG ICONS (inline, no external deps)
// =============================================================================

const ICON = {
  calendar: '<svg class="nc-event-meta-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="14" height="13" rx="2"/><line x1="3" y1="8" x2="17" y2="8"/><line x1="7" y1="2" x2="7" y2="5"/><line x1="13" y1="2" x2="13" y2="5"/></svg>',
  clock: '<svg class="nc-event-meta-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7"/><polyline points="10,6 10,10 13,12"/></svg>',
  pin: '<svg class="nc-event-meta-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 18s-6-5.3-6-9a6 6 0 1 1 12 0c0 3.7-6 9-6 9z"/><circle cx="10" cy="9" r="2"/></svg>',
  ticket: '<svg class="nc-event-meta-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 7V5a1 1 0 011-1h14a1 1 0 011 1v2a2 2 0 100 4v2a1 1 0 01-1 1H3a1 1 0 01-1-1v-2a2 2 0 100-4z"/></svg>',
  link: '<svg class="nc-event-meta-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 12l4-4m-2-2l1.5-1.5a3 3 0 014.2 4.2L14 10m-4 0l-1.5 1.5a3 3 0 01-4.2-4.2L6 6"/></svg>',
  accessible: '<svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><circle cx="10" cy="4" r="2"/><path d="M14 20a6 6 0 10-8 0h2a4 4 0 118 0h2z"/><path d="M8 8h4v5H8z"/></svg>',
  download: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 3v10m0 0l-3-3m3 3l3-3"/><path d="M3 14v2a1 1 0 001 1h12a1 1 0 001-1v-2"/></svg>',
  gcal: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="14" height="13" rx="2"/><line x1="3" y1="8" x2="17" y2="8"/><line x1="7" y1="2" x2="7" y2="5"/><line x1="13" y1="2" x2="13" y2="5"/><line x1="7" y1="11" x2="10" y2="11"/><line x1="7" y1="14" x2="13" y2="14"/></svg>',
};

// =============================================================================
// PAGE TEMPLATES
// =============================================================================

function pageShell(title: string, description: string, canonical: string, ogImage: string | null, head: string, body: string): string {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeAttr(description.slice(0, 200));
  const ogImg = ogImage ? `<meta property="og:image" content="${escapeAttr(ogImage)}">` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle} | ${SITE_NAME}</title>
<meta name="description" content="${safeDesc}">
<link rel="canonical" href="${escapeAttr(canonical)}">

<!-- Open Graph -->
<meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="${safeDesc}">
<meta property="og:url" content="${escapeAttr(canonical)}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="website">
${ogImg}

<!-- Twitter Card -->
<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${safeTitle}">
<meta name="twitter:description" content="${safeDesc}">
${ogImage ? `<meta name="twitter:image" content="${escapeAttr(ogImage)}">` : ''}

<!-- Fonts -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">

<!-- Styles -->
<link rel="stylesheet" href="${SITE_DOMAIN}/pages.css">

${head}
</head>
<body>
<div class="nc-page">
<header class="nc-header">
<div class="nc-header-inner">
  <a href="${SITE_DOMAIN}" class="nc-logo">${SITE_NAME}</a>
  <nav class="nc-header-nav">
    <a href="${SITE_DOMAIN}/api/v1/events">API</a>
    <a href="${SITE_DOMAIN}/api/v1/events.ics">iCal Feed</a>
    <a href="${SITE_DOMAIN}/llms.txt">llms.txt</a>
  </nav>
</div>
</header>
<main class="nc-main${body.includes('nc-main--wide') ? ' nc-main--wide' : ''}">
${body}
</main>
<footer class="nc-footer">
  ${SITE_NAME} &middot; Open event data for the neighborhood &middot;
  <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>
</footer>
</div>
</body>
</html>`;
}

function renderEventCard(row: Record<string, unknown>, timezone?: string): string {
  const tz = timezone || (row.event_timezone as string) || 'America/New_York';
  const { month, day } = formatShortDate(row.event_at as string, tz);
  const time = formatTime(row.event_at as string, tz);
  const cat = getCategoryInfo(row.category as string);
  const venue = escapeHtml((row.place_name as string) || '');

  return `<a href="${SITE_DOMAIN}/events/${row.id}" class="nc-card" style="text-decoration:none">
  <div class="nc-card-date">
    <div class="nc-card-month">${month}</div>
    <div class="nc-card-day">${day}</div>
  </div>
  <div class="nc-card-body">
    <div class="nc-card-title">${escapeHtml(row.content as string)}</div>
    <div class="nc-card-detail">${time}${venue ? ' &middot; ' + venue : ''}</div>
  </div>
  <span class="nc-card-badge" style="background:${cat.color}">${escapeHtml(cat.label)}</span>
</a>`;
}

// =============================================================================
// ROUTES
// =============================================================================

/**
 * GET /events/:id
 * Public event detail page with structured data and social sharing tags.
 */
router.get('/events/:id',async (req, res, next) => {
  try {
    const id = req.params.id;

    // Basic UUID check
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      res.status(404).send(render404()); return;
    }

    const { data: row, error } = await supabaseAdmin
      .from('events')
      .select(EVENTS_SELECT)
      .eq('id', id)
      .eq('status', 'published')
      .maybeSingle();

    if (error || !row) {
      res.status(404).send(render404()); return;
    }

    const tz = (row.event_timezone as string) || 'America/New_York';
    const name = row.content as string;
    const desc = (row.description as string) || '';
    const venue = (row.place_name as string) || '';
    const address = (row.venue_address as string) || '';
    const fullLocation = venue + (address ? ', ' + address : '');
    const startIso = toIso(row.event_at as string, tz);
    const endIso = row.end_time ? toIso(row.end_time as string, tz) : null;
    const cat = getCategoryInfo(row.category as string);
    const imageUrl = resolveEventImageUrl(row.event_image_url as string | null, SITE_DOMAIN);
    const canonical = `${SITE_DOMAIN}/events/${row.id}`;
    const price = (row.price as string) || null;
    const linkUrl = (row.link_url as string) || null;
    const tags = (row.tags as string[] | null) || [];
    const accessible = row.wheelchair_accessible as boolean | null;
    const acct = row.portal_accounts as { business_name?: string } | null;
    const publisher = (row.source_publisher as string) || acct?.business_name || SITE_NAME;
    const method = (row.source_method as string) || 'portal';

    const dateDisplay = formatDate(row.event_at as string, tz);
    const timeDisplay = formatTimeRange(row.event_at as string, row.end_time as string | null, tz);

    // Structured data (Schema.org Event)
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'Event',
      name,
      startDate: startIso,
      ...(endIso && { endDate: endIso }),
      location: {
        '@type': 'Place',
        name: venue || 'TBD',
        ...(address && { address }),
      },
      ...(desc && { description: desc.slice(0, 500) }),
      ...(imageUrl && { image: imageUrl }),
      ...(price && {
        offers: {
          '@type': 'Offer',
          price: price.toLowerCase().includes('free') ? '0' : price,
          priceCurrency: 'USD',
          availability: 'https://schema.org/InStock',
        },
      }),
      organizer: { '@type': 'Organization', name: publisher },
    };

    // .ics download data URL
    const icsContent = singleEventIcs(row);
    const icsDataUrl = `data:text/calendar;charset=utf-8,${encodeURIComponent(icsContent)}`;

    // Google Calendar link
    const gcalUrl = googleCalendarUrl(name, startIso, endIso, fullLocation, desc);

    // Venue link (if the event has a creator_account_id, try to link to venue page)
    let venueLink = '';
    if (row.creator_account_id) {
      const { data: account } = await supabaseAdmin
        .from('portal_accounts')
        .select('slug')
        .eq('id', row.creator_account_id as string)
        .maybeSingle();
      if (account?.slug) {
        venueLink = `${SITE_DOMAIN}/venues/${account.slug}`;
      }
    }

    const head = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;

    const body = `
${imageUrl ? `<img class="nc-event-hero" src="${escapeAttr(imageUrl)}" alt="${escapeAttr(name)}">` : ''}

<span class="nc-event-category" style="background:${cat.color}">${escapeHtml(cat.label)}</span>

<h1 class="nc-event-title">${escapeHtml(name)}</h1>

<div class="nc-event-meta">
  <div class="nc-event-meta-row">
    ${ICON.calendar}
    <span class="nc-event-meta-text">${escapeHtml(dateDisplay)}</span>
  </div>
  <div class="nc-event-meta-row">
    ${ICON.clock}
    <span class="nc-event-meta-text">${escapeHtml(timeDisplay)}</span>
  </div>
  ${venue ? `<div class="nc-event-meta-row">
    ${ICON.pin}
    <span class="nc-event-meta-text">${venueLink ? `<a href="${escapeAttr(venueLink)}">${escapeHtml(venue)}</a>` : escapeHtml(venue)}${address ? `<br><span style="color:var(--nc-muted);font-size:13px">${escapeHtml(address)}</span>` : ''}</span>
  </div>` : ''}
  ${price ? `<div class="nc-event-meta-row">
    ${ICON.ticket}
    <span class="nc-event-meta-text">${escapeHtml(price)}</span>
  </div>` : ''}
  ${linkUrl ? (() => {
    let hostname = linkUrl;
    try { hostname = new URL(linkUrl).hostname; } catch { /* malformed URL — show raw */ }
    return `<div class="nc-event-meta-row">
    ${ICON.link}
    <span class="nc-event-meta-text"><a href="${escapeAttr(linkUrl)}" target="_blank" rel="noopener">${escapeHtml(hostname)}</a></span>
  </div>`;
  })() : ''}
  ${accessible ? `<div class="nc-event-meta-row">
    ${ICON.accessible}
    <span class="nc-accessible">Wheelchair accessible</span>
  </div>` : ''}
</div>

${tags.length > 0 ? `<div class="nc-tags">${tags.map(t => `<span class="nc-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}

${desc ? `<div class="nc-event-description">${escapeHtml(desc)}</div>` : ''}

<div class="nc-actions">
  <a class="nc-btn nc-btn--primary" href="${escapeAttr(gcalUrl)}" target="_blank" rel="noopener">${ICON.gcal} Add to Google Calendar</a>
  <a class="nc-btn" href="${escapeAttr(icsDataUrl)}" download="${escapeAttr(name.replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '-').toLowerCase())}.ics">${ICON.download} Download .ics</a>
  ${linkUrl ? `<a class="nc-btn" href="${escapeAttr(linkUrl)}" target="_blank" rel="noopener">${ICON.link} Event Website</a>` : ''}
</div>

<div class="nc-source">
  <span class="nc-source-badge">Source: ${escapeHtml(publisher)} via ${escapeHtml(method)}</span>
  &middot; <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>
</div>`;

    const html = pageShell(name, desc || `${name} at ${venue}`, canonical, imageUrl, head, body);

    res
      .set('Content-Type', 'text/html; charset=utf-8')
      .set('Cache-Control', 'public, max-age=300')
      .send(html);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /venues/:slug
 * Public venue page showing upcoming events.
 */
router.get('/venues/:slug',async (req, res, next) => {
  try {
    const slug = req.params.slug.toLowerCase();

    // Validate slug format
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) || slug.length < 2) {
      res.status(404).send(render404()); return;
    }

    const { data: account, error: acctErr } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, business_name, slug, description, website, logo_url, default_address, default_latitude, default_longitude')
      .eq('slug', slug)
      .eq('status', 'active')
      .maybeSingle();

    if (acctErr || !account) {
      res.status(404).send(render404()); return;
    }

    // Fetch upcoming events for this venue
    const { data: events } = await supabaseAdmin
      .from('events')
      .select(EVENTS_SELECT)
      .eq('creator_account_id', account.id)
      .eq('status', 'published')
      .gte('event_at', new Date().toISOString())
      .order('event_at', { ascending: true })
      .limit(50);

    const venueEvents = events || [];
    const venueName = account.business_name as string;
    const canonical = `${SITE_DOMAIN}/venues/${slug}`;
    const bio = (account.description as string) || '';
    const websiteUrl = (account.website as string) || '';
    const address = (account.default_address as string) || '';
    const logoUrl = resolveEventImageUrl(account.logo_url as string | null, SITE_DOMAIN);

    // Structured data (Schema.org LocalBusiness)
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      name: venueName,
      ...(address && { address }),
      ...(websiteUrl && { url: websiteUrl }),
      ...(logoUrl && { image: logoUrl }),
      ...(bio && { description: bio }),
    };

    const head = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;

    const icalUrl = `${SITE_DOMAIN}/venues/${slug}/events.ics`;
    const widgetSnippet = `<div id="nc-events" data-venue="${escapeAttr(slug)}" data-limit="10"></div>\n<script src="${SITE_DOMAIN}/widget/events.js" async></script>`;

    const body = `
<div class="nc-venue-header">
  <h1 class="nc-venue-name">${escapeHtml(venueName)}</h1>
  ${address ? `<p class="nc-venue-address">${escapeHtml(address)}</p>` : ''}
  ${bio ? `<p class="nc-venue-bio">${escapeHtml(bio)}</p>` : ''}
  <div class="nc-venue-links">
    ${websiteUrl ? `<a href="${escapeAttr(websiteUrl)}" target="_blank" rel="noopener">Website</a>` : ''}
    <a href="${escapeAttr(icalUrl)}">Subscribe (iCal)</a>
  </div>
  <p class="nc-venue-stat">${venueEvents.length} upcoming event${venueEvents.length !== 1 ? 's' : ''}</p>
</div>

${venueEvents.length > 0 ? `
<h2 class="nc-section-title">Upcoming Events</h2>
<div class="nc-event-list">
  ${venueEvents.map(e => renderEventCard(e as unknown as Record<string, unknown>)).join('\n  ')}
</div>
` : `
<div class="nc-empty">
  <div class="nc-empty-icon">&#x1F4C5;</div>
  No upcoming events. Check back soon.
</div>
`}

<div class="nc-subscribe">
  <h3 class="nc-subscribe-title">Subscribe to ${escapeHtml(venueName)}</h3>
  <p style="font-size:13px;color:var(--nc-muted);margin-bottom:12px">
    Add this iCal feed to your calendar app to get updates automatically:
  </p>
  <div class="nc-code-block">${escapeHtml(icalUrl)}</div>
  <div class="nc-actions" style="border:0;padding-top:0;margin-bottom:0">
    <a class="nc-btn" href="${escapeAttr(icalUrl)}">Subscribe in Calendar App</a>
  </div>
</div>

<div class="nc-subscribe" style="margin-top:16px">
  <h3 class="nc-subscribe-title">Embed events on your website</h3>
  <p style="font-size:13px;color:var(--nc-muted);margin-bottom:12px">
    Add this snippet to any webpage to show upcoming events:
  </p>
  <div class="nc-code-block">${escapeHtml(widgetSnippet)}</div>
</div>`;

    const html = pageShell(
      venueName,
      bio || `Upcoming events at ${venueName}`,
      canonical,
      logoUrl,
      head,
      body,
    );

    res
      .set('Content-Type', 'text/html; charset=utf-8')
      .set('Cache-Control', 'public, max-age=300')
      .send(html);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /venues/:slug/events.ics
 * Per-venue iCal feed — subscribe in any calendar app.
 */
router.get('/venues/:slug/events.ics',async (req, res, next) => {
  try {
    const slug = req.params.slug.toLowerCase();

    const { data: account } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, business_name')
      .eq('slug', slug)
      .eq('status', 'active')
      .maybeSingle();

    if (!account) {
      res.status(404).set('Content-Type', 'text/plain').send('Venue not found'); return;
    }

    const { data: events } = await supabaseAdmin
      .from('events')
      .select('id, content, description, place_name, venue_address, event_at, end_time, event_timezone, latitude, longitude, link_url, recurrence')
      .eq('creator_account_id', account.id)
      .eq('status', 'published')
      .gte('event_at', new Date().toISOString())
      .order('event_at', { ascending: true })
      .limit(200);

    const rows = events || [];
    const venueName = account.business_name as string;

    const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

    const fmtDt = (iso: string) => {
      try {
        return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      } catch {
        return '';
      }
    };

    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Neighborhood Commons//Events//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${esc(venueName)} - ${SITE_NAME}`,
    ];

    for (const row of rows) {
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${row.id}@commons.joinfiber.app`);
      lines.push(`DTSTART:${fmtDt(row.event_at as string)}`);
      if (row.end_time) lines.push(`DTEND:${fmtDt(row.end_time as string)}`);
      lines.push(`SUMMARY:${esc(row.content as string)}`);
      if (row.description) lines.push(`DESCRIPTION:${esc(row.description as string)}`);
      if (row.place_name) {
        const loc = (row.place_name as string) + ((row.venue_address as string | null) ? ', ' + row.venue_address : '');
        lines.push(`LOCATION:${esc(loc)}`);
      }
      if (row.link_url) lines.push(`URL:${row.link_url}`);
      if (row.latitude != null && row.longitude != null) {
        lines.push(`GEO:${row.latitude};${row.longitude}`);
      }
      lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');

    res
      .set('Content-Type', 'text/calendar; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${slug}-events.ics"`)
      .set('Cache-Control', 'public, max-age=900')
      .send(lines.join('\r\n'));
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// 404 PAGE
// =============================================================================

function render404(): string {
  return pageShell('Not Found', 'The page you were looking for does not exist.', SITE_DOMAIN, null, '', `
<div class="nc-error">
  <div class="nc-error-code">404</div>
  <p class="nc-error-message">This page doesn't exist, or the event may have been removed.</p>
  <a class="nc-btn" href="${SITE_DOMAIN}">Back to ${SITE_NAME}</a>
</div>`);
}

export default router;
