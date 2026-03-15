/**
 * Neighborhood Commons — Embeddable Events Widget
 *
 * Drop this script tag + container div on any webpage to show upcoming events.
 *
 * Usage:
 *   <div id="nc-events" data-limit="10"></div>
 *   <script src="https://commons.joinfiber.app/widget/events.js" async></script>
 *
 * Configuration (data attributes on the container div):
 *   data-limit    — Max events to show (default: 10, max: 50)
 *   data-venue    — Venue slug to filter by
 *   data-category — Category slug to filter by (e.g., "live-music")
 *   data-region   — Region slug to filter by
 *   data-theme    — "light" (default) or "dark"
 *
 * Shadow DOM used for style isolation — won't conflict with host page CSS.
 * No external dependencies. < 8KB gzipped.
 */
(function () {
  'use strict';

  // Find the container
  var container = document.getElementById('nc-events');
  if (!container) return;

  // Read config from data attributes
  var limit = Math.min(parseInt(container.getAttribute('data-limit')) || 10, 50);
  var venue = container.getAttribute('data-venue') || '';
  var category = container.getAttribute('data-category') || '';
  var region = container.getAttribute('data-region') || '';
  var theme = container.getAttribute('data-theme') || 'light';

  // Determine API base from the script src
  var scripts = document.querySelectorAll('script[src*="widget/events.js"]');
  var scriptSrc = scripts.length ? scripts[scripts.length - 1].src : '';
  var apiBase = scriptSrc ? scriptSrc.replace(/\/widget\/events\.js.*$/, '') : 'https://commons.joinfiber.app';

  // Build API URL
  var url = apiBase + '/api/v1/events?limit=' + limit;
  if (category) url += '&category=' + encodeURIComponent(category);
  // Venue filtering uses the existing API's query parameter if available
  // For now, we filter client-side after fetch if venue is specified

  // Category colors (must match server-side categories.ts)
  var COLORS = {
    'live-music': '#E85D3A', 'dj-dance': '#A855F7', 'comedy': '#F59E0B',
    'trivia': '#6366F1', 'karaoke': '#EC4899', 'open-mic': '#8B5CF6',
    'art-gallery': '#B47AEA', 'workshop-class': '#F97316', 'happy-hour': '#F59E0B',
    'food-drink': '#E8943E', 'market-popup': '#14B8A6', 'community': '#22C55E',
    'sports': '#3B82F6', 'film-screenings': '#EF4444', 'other': '#6B7280'
  };

  // CSS for the widget (injected into Shadow DOM)
  var isDark = theme === 'dark';
  var css = '\
:host { display: block; font-family: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }\
* { box-sizing: border-box; margin: 0; padding: 0; }\
.nc-w { background: ' + (isDark ? '#1a1917' : '#ffffff') + '; border: 1px solid ' + (isDark ? '#2a2825' : '#e8e6e1') + '; border-radius: 10px; overflow: hidden; }\
.nc-w-header { padding: 16px 20px 12px; border-bottom: 1px solid ' + (isDark ? '#2a2825' : '#e8e6e1') + '; }\
.nc-w-title { font-size: 14px; font-weight: 500; letter-spacing: 0.02em; color: ' + (isDark ? '#d4d0c8' : '#37352f') + '; }\
.nc-w-list { padding: 0; }\
.nc-w-item { display: grid; grid-template-columns: 48px 1fr auto; gap: 12px; align-items: center; padding: 12px 20px; border-bottom: 1px solid ' + (isDark ? '#2a2825' : '#f0eeea') + '; text-decoration: none; transition: background 0.1s; }\
.nc-w-item:last-child { border-bottom: none; }\
.nc-w-item:hover { background: ' + (isDark ? '#22201e' : '#fafaf8') + '; }\
.nc-w-date { text-align: center; }\
.nc-w-month { font-size: 10px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: ' + (isDark ? '#6b6660' : '#9c9791') + '; line-height: 1; }\
.nc-w-day { font-size: 20px; font-weight: 500; letter-spacing: -0.02em; color: ' + (isDark ? '#d4d0c8' : '#37352f') + '; line-height: 1.3; }\
.nc-w-body { min-width: 0; }\
.nc-w-name { font-size: 14px; font-weight: 500; color: ' + (isDark ? '#d4d0c8' : '#37352f') + '; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\
.nc-w-detail { font-size: 12px; color: ' + (isDark ? '#6b6660' : '#9c9791') + '; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\
.nc-w-badge { display: inline-block; font-size: 9px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 7px; border-radius: 100px; color: #fff; white-space: nowrap; }\
.nc-w-footer { padding: 12px 20px; border-top: 1px solid ' + (isDark ? '#2a2825' : '#e8e6e1') + '; display: flex; align-items: center; justify-content: space-between; }\
.nc-w-footer a { font-size: 12px; color: ' + (isDark ? '#6b6660' : '#9c9791') + '; text-decoration: none; }\
.nc-w-footer a:hover { color: ' + (isDark ? '#d4d0c8' : '#37352f') + '; text-decoration: underline; }\
.nc-w-powered { font-size: 11px; color: ' + (isDark ? '#4a4740' : '#c0bdb8') + '; display: flex; align-items: center; gap: 4px; }\
.nc-w-powered a { color: inherit; }\
.nc-w-empty { padding: 32px 20px; text-align: center; font-size: 13px; color: ' + (isDark ? '#6b6660' : '#9c9791') + '; }\
.nc-w-loading { padding: 32px 20px; text-align: center; font-size: 13px; color: ' + (isDark ? '#4a4740' : '#c0bdb8') + '; }\
@media (max-width: 480px) {\
  .nc-w-item { grid-template-columns: 40px 1fr; gap: 10px; padding: 10px 16px; }\
  .nc-w-badge { display: none; }\
  .nc-w-header, .nc-w-footer { padding-left: 16px; padding-right: 16px; }\
}\
';

  // Create Shadow DOM
  var shadow = container.attachShadow({ mode: 'open' });

  // Inject font
  var fontLink = document.createElement('link');
  fontLink.rel = 'stylesheet';
  fontLink.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&display=swap';
  shadow.appendChild(fontLink);

  // Inject styles
  var style = document.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);

  // Root element
  var root = document.createElement('div');
  root.className = 'nc-w';
  root.innerHTML = '<div class="nc-w-loading">Loading events\u2026</div>';
  shadow.appendChild(root);

  // Helper: format date parts
  function fmtDate(iso, tz) {
    try {
      var d = new Date(iso);
      return {
        month: d.toLocaleDateString('en-US', { timeZone: tz, month: 'short' }).toUpperCase(),
        day: d.toLocaleDateString('en-US', { timeZone: tz, day: 'numeric' })
      };
    } catch (e) {
      return { month: '???', day: '?' };
    }
  }

  function fmtTime(iso, tz) {
    try {
      return new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
    } catch (e) {
      return '';
    }
  }

  function esc(t) {
    var d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
  }

  // Fetch and render
  fetch(url)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (json) {
      var events = json.events || json.data || [];

      // Client-side venue filter if specified
      if (venue && events.length) {
        events = events.filter(function (e) {
          var loc = e.location && e.location.name ? e.location.name.toLowerCase() : '';
          var orgName = e.organizer && e.organizer.name ? e.organizer.name.toLowerCase() : '';
          var slug = venue.toLowerCase().replace(/-/g, ' ');
          return loc.indexOf(slug) !== -1 || orgName.indexOf(slug) !== -1;
        });
      }

      if (!events.length) {
        root.innerHTML = '<div class="nc-w-empty">No upcoming events</div>' +
          '<div class="nc-w-footer"><span class="nc-w-powered"><a href="' + apiBase + '">Neighborhood Commons</a></span></div>';
        return;
      }

      var html = '<div class="nc-w-list">';
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var tz = ev.timezone || 'America/New_York';
        var dt = fmtDate(ev.start, tz);
        var time = fmtTime(ev.start, tz);
        var catSlug = (ev.category && ev.category[0]) || 'other';
        var catColor = COLORS[catSlug] || '#6B7280';
        var catLabel = catSlug.replace(/-/g, ' ');
        var venueName = ev.location && ev.location.name ? ev.location.name : '';
        var eventUrl = apiBase + '/events/' + ev.id;

        html += '<a class="nc-w-item" href="' + esc(eventUrl) + '" target="_blank" rel="noopener">' +
          '<div class="nc-w-date"><div class="nc-w-month">' + esc(dt.month) + '</div><div class="nc-w-day">' + esc(dt.day) + '</div></div>' +
          '<div class="nc-w-body"><div class="nc-w-name">' + esc(ev.name) + '</div><div class="nc-w-detail">' + esc(time) + (venueName ? ' &middot; ' + esc(venueName) : '') + '</div></div>' +
          '<span class="nc-w-badge" style="background:' + catColor + '">' + esc(catLabel) + '</span>' +
          '</a>';
      }
      html += '</div>';

      html += '<div class="nc-w-footer">' +
        '<a href="' + apiBase + '/api/v1/events" target="_blank" rel="noopener">View all events &rarr;</a>' +
        '<span class="nc-w-powered">Powered by <a href="' + apiBase + '" target="_blank" rel="noopener">Neighborhood Commons</a></span>' +
        '</div>';

      root.innerHTML = html;
    })
    .catch(function () {
      root.innerHTML = '<div class="nc-w-empty">Unable to load events</div>' +
        '<div class="nc-w-footer"><span class="nc-w-powered"><a href="' + apiBase + '">Neighborhood Commons</a></span></div>';
    });
})();
