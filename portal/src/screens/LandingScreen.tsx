import { useState, useEffect } from 'react';
import { RegisterCard } from '../components/RegisterCard';

// =============================================================================
// PROPS
// =============================================================================

interface LandingScreenProps {
  onShowLogin: () => void;
  onShowDevelopers: () => void;
}

// =============================================================================
// DESIGN TOKENS — light theme (matches pages.css variables)
// =============================================================================

const lc = {
  bg: '#f8f8f6',
  surface: '#ffffff',
  text: '#37352f',
  heading: '#1a1917',
  muted: '#6b6660',
  dim: '#9c9791',
  border: '#e8e6e1',
  accent: '#2c2c2c',
  accentDim: '#2c2c2c08',
  cream: '#f5f0e8',
  error: '#c0392b',
  success: '#2d8a4e',
  code: '#f0eeea',
} as const;

const API_BASE = 'https://api.neighborhood-commons.org';

// =============================================================================
// SCREEN
// =============================================================================

export function LandingScreen({ onShowLogin, onShowDevelopers }: LandingScreenProps) {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 820);
  const [stats, setStats] = useState<{ events: number; venues: number; region: string } | null>(null);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 820);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Fetch stats once on mount
  useEffect(() => {
    fetch(`${API_BASE}/api/v1/meta/stats`)
      .then(r => r.json())
      .then(d => {
        if (d.events != null) setStats({ events: d.events, venues: d.venues, region: d.region || '' });
      })
      .catch(() => {});
  }, []);

  const m = isMobile;

  return (
    <div style={{ minHeight: '100vh', background: lc.bg, color: lc.text }}>
      <div style={{ maxWidth: '760px', margin: '0 auto', padding: m ? '48px 24px 64px' : '72px 32px 80px' }}>

        {/* ── HERO ─────────────────────────────────────────────────── */}
        <div style={{ marginBottom: m ? '48px' : '64px' }}>
          <div style={{
            fontSize: '11px',
            fontWeight: 500,
            letterSpacing: '0.16em',
            textTransform: 'uppercase' as const,
            color: lc.dim,
            marginBottom: '20px',
          }}>
            neighborhood commons
          </div>

          <h1 style={{
            fontSize: m ? '32px' : '48px',
            fontWeight: 400,
            lineHeight: 1.15,
            color: lc.heading,
            margin: '0 0 20px 0',
            letterSpacing: '-0.02em',
          }}>
            A public database of{m ? <br /> : ' '}neighborhood events.
          </h1>

          <p style={{
            fontSize: m ? '16px' : '18px',
            lineHeight: 1.7,
            color: lc.muted,
            margin: 0,
            maxWidth: '580px',
          }}>
            Open infrastructure for local event data. Read for free. Contribute via CSV or API. All data is CC BY 4.0.
            {stats && stats.events > 0 && (
              <span style={{ display: 'block', marginTop: '8px', color: lc.text }}>
                Currently serving <strong>{stats.events.toLocaleString()} events</strong>
                {stats.venues > 0 && <> across <strong>{stats.venues.toLocaleString()} venues</strong></>}
                {stats.region && <> in <strong>{stats.region}</strong></>}.
              </span>
            )}
          </p>
        </div>

        {/* ── GET STARTED — two paths ──────────────────────────────── */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: m ? '1fr' : '1fr 1fr',
          gap: '16px',
          marginBottom: '48px',
        }}>
          {/* CSV Upload */}
          <div style={{
            background: lc.surface,
            border: `1px solid ${lc.border}`,
            borderRadius: '12px',
            padding: '24px',
          }}>
            <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase' as const, color: lc.dim, marginBottom: '12px' }}>
              Upload data
            </div>
            <p style={{ fontSize: '15px', color: lc.text, lineHeight: 1.6, margin: '0 0 16px' }}>
              Have a spreadsheet of events, food pantries, or community resources? Upload a CSV — we'll map the columns and you confirm.
            </p>
            <button
              type="button"
              onClick={onShowLogin}
              style={{
                background: lc.accent,
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                padding: '10px 20px',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Sign in to upload
            </button>
          </div>

          {/* API */}
          <div style={{
            background: lc.surface,
            border: `1px solid ${lc.border}`,
            borderRadius: '12px',
            padding: '24px',
          }}>
            <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase' as const, color: lc.dim, marginBottom: '12px' }}>
              Build with the API
            </div>
            <p style={{ fontSize: '15px', color: lc.text, lineHeight: 1.6, margin: '0 0 16px' }}>
              Pull events into your app. Push events back. No API key required to read — get one for write access and webhooks.
            </p>
            <a
              href="#register"
              onClick={(e) => { e.preventDefault(); document.getElementById('register')?.scrollIntoView({ behavior: 'smooth' }); }}
              style={{
                display: 'inline-block',
                background: lc.surface,
                color: lc.accent,
                border: `1px solid ${lc.border}`,
                borderRadius: '8px',
                padding: '10px 20px',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
                textDecoration: 'none',
                fontFamily: 'inherit',
              }}
            >
              Get an API key
            </a>
          </div>
        </div>

        {/* ── TRY IT NOW ───────────────────────────────────────────── */}
        <SectionLabel>Try it now</SectionLabel>
        <Code>{`$ curl "${API_BASE}/api/v1/events?limit=3"

# By category
$ curl "${API_BASE}/api/v1/events?category=live-music"

# Near a location
$ curl "${API_BASE}/api/v1/events?near=39.97,-75.14&radius_km=2"

# Calendar feed
${API_BASE}/api/v1/events.ics`}</Code>
        <p style={dimNote}>No authentication required. Returns JSON. Also available as .ics and .rss feeds.</p>

        {/* ── GET AN API KEY ───────────────────────────────────────── */}
        <div id="register" style={{ scrollMarginTop: '24px' }}>
          <SectionLabel>Get an API key</SectionLabel>
          <RegisterCard
            buttonLabel="Get an API Key"
            description="Free, instant, no approval. Gives you a dedicated rate limit bucket (1,000 req/hr) and access to webhooks and the Contribute API."
          />
        </div>

        {/* ── WHAT'S IN THE DATA ───────────────────────────────────── */}
        <SectionLabel>What's in the data</SectionLabel>
        <p style={prose}>
          An event is a public fact. Something happens, somewhere, at some time. The Commons stores the essentials and serves them to anyone who asks.
        </p>
        <div style={{
          display: 'grid',
          gridTemplateColumns: m ? '1fr' : '1fr 1fr',
          gap: '12px 40px',
          marginBottom: '32px',
        }}>
          {[
            ['What', 'Name and description'],
            ['Where', 'Venue, address, coordinates'],
            ['When', 'Start time, end time, timezone'],
            ['How much', 'Free, $10, $5\u201315'],
            ['Category', 'One of 20 structured types'],
            ['Link', 'Event page, tickets, or listing URL'],
            ['Image', 'Cover photo per event, logo per venue'],
            ['Recurrence', 'Weekly, monthly, custom patterns'],
            ['Tags', 'Access, vibe, format descriptors'],
          ].map(([label, desc]) => (
            <div key={label} style={{ display: 'flex', gap: '12px', padding: '4px 0' }}>
              <span style={{ color: lc.heading, fontSize: '14px', fontWeight: 500, minWidth: '80px' }}>{label}</span>
              <span style={{ color: lc.muted, fontSize: '14px' }}>{desc}</span>
            </div>
          ))}
        </div>
        <p style={dimNote}>Every event response is self-contained. No joins, no implicit knowledge, no extra calls.</p>

        {/* ── READ API ─────────────────────────────────────────────── */}
        <SectionLabel>Read API</SectionLabel>
        <div style={endpointList}>
          <EP method="GET" path="/api/v1/events" desc="List events (filter, search, paginate)" />
          <EP method="GET" path="/api/v1/events/:id" desc="Single event by ID" />
          <EP method="GET" path="/api/v1/events.ics" desc="iCalendar feed" />
          <EP method="GET" path="/api/v1/events.rss" desc="RSS 2.0 feed" />
          <EP method="GET" path="/api/v1/accounts" desc="Search venues" />
          <EP method="GET" path="/api/v1/groups" desc="Community groups and orgs" />
          <EP method="GET" path="/api/v1/meta" desc="Feed metadata, stats, regions, categories" />
        </div>
        <p style={dimNote}>
          Rate limit: 1,000 requests/hour per IP (or per API key).{' '}
          <button type="button" onClick={onShowDevelopers} style={linkButton}>Full API reference &rarr;</button>
        </p>

        {/* ── CONTRIBUTE API ───────────────────────────────────────── */}
        <SectionLabel>Contribute API</SectionLabel>
        <p style={prose}>
          Push events into the commons with your API key. New keys start at <strong>pending</strong> (events enter review). Upgrades to auto-publish are manual.
        </p>
        <div style={endpointList}>
          <EP method="POST" path="/api/v1/contribute" desc="Submit an event (supports recurrence)" auth />
          <EP method="POST" path="/api/v1/contribute/batch" desc="Submit up to 50 events" auth />
          <EP method="GET" path="/api/v1/contribute/mine" desc="List your submitted events" auth />
        </div>
        <Code>{`curl -X POST ${API_BASE}/api/v1/contribute \\
  -H "X-API-Key: nc_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Open Mic Night",
    "start": "2026-04-15T19:00:00-04:00",
    "timezone": "America/New_York",
    "category": "open-mic",
    "location": { "name": "The Coffee Shop" }
  }'`}</Code>
        <p style={dimNote}>
          <button type="button" onClick={onShowDevelopers} style={linkButton}>Full contribute docs &rarr;</button>
        </p>

        {/* ── WEBHOOKS ─────────────────────────────────────────────── */}
        <SectionLabel>Real-time webhooks</SectionLabel>
        <p style={prose}>
          Subscribe to <code style={inlineCode}>event.created</code>, <code style={inlineCode}>event.updated</code>, and <code style={inlineCode}>event.deleted</code>. HMAC-SHA256 signed. Automatic retries.{' '}
          <button type="button" onClick={onShowDevelopers} style={linkButton}>Webhook setup guide &rarr;</button>
        </p>

        {/* ── EXPRESSIONS ──────────────────────────────────────────── */}
        <SectionLabel>Expressions of the Commons</SectionLabel>
        <p style={prose}>
          The data is open and the use cases are unlimited. These are some of the ways it's already being put to work.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '40px' }}>
          <AppCard
            name="merrie.co"
            href="https://merrie.co"
            desc="Curators discover and organize events. Venue pages are built automatically. The easiest way for non-developers to interact with Commons data."
          />
          <AppCard
            name="Fiber"
            href="https://joinfiber.app"
            desc="A mobile app for social event discovery. Browse feeds, share plans with friends, find what's on tonight. Same data, different experience."
          />
          <AppCard
            name="Yours"
            desc="A nightlife guide. A community calendar. A civic dashboard. A newsletter. Whatever your audience, the data is here."
            placeholder
          />
        </div>

        {/* ── WHY THIS EXISTS ──────────────────────────────────────── */}
        <SectionLabel>Why this exists</SectionLabel>
        <p style={prose}>
          Events are public facts. A band plays at a bar on Thursday. A yoga class meets in the park on Saturday mornings. These are not opinions. They are not proprietary. They are things that happen in the world, and anyone should be able to know about them.
        </p>
        <p style={{ ...prose, color: lc.dim }}>
          The Commons is thin on purpose. It stores data and serves it. It doesn't editorialize, recommend, or curate. Those are the concerns of the apps that build on top. The Commons is plumbing — and good plumbing doesn't change with the winds.
        </p>

        {/* ── STABILITY ────────────────────────────────────────────── */}
        <div style={{
          background: lc.cream,
          borderRadius: '10px',
          padding: '20px 24px',
          marginBottom: '40px',
          fontSize: '14px',
          lineHeight: 1.7,
          color: lc.text,
        }}>
          <strong>The v1 API is stable.</strong> Breaking changes to <code style={inlineCode}>/api/v1/*</code> require 90+ days notice. Response shapes, query parameters, and auth requirements are locked.
        </div>

        {/* ── FOOTER ───────────────────────────────────────────────── */}
        <footer style={{
          borderTop: `1px solid ${lc.border}`,
          paddingTop: '24px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '10px 24px',
          alignItems: 'center',
          fontSize: '13px',
        }}>
          <button type="button" onClick={onShowDevelopers} style={footerLink}>API Reference</button>
          <a href="/llms.txt" style={footerLink}>AI-Readable Docs</a>
          <a href="https://github.com/The-Relational-Technology-Project/neighborhood-api" style={footerLink} target="_blank" rel="noopener noreferrer">Neighborhood API Spec</a>
          <a href="https://github.com/joinfiber/neighborhood-commons" style={footerLink} target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="#/terms" style={footerLink}>Terms</a>
          <button type="button" onClick={onShowLogin} style={footerLink}>Contributor Sign In</button>
          <div style={{ flex: 1 }} />
          <span style={{ color: lc.dim, fontSize: '12px' }}>CC BY 4.0 &middot; MIT &middot; hello@joinfiber.app</span>
        </footer>
      </div>
    </div>
  );
}

// =============================================================================
// SHARED STYLES
// =============================================================================

const prose: React.CSSProperties = {
  fontSize: '15px',
  lineHeight: 1.7,
  color: '#6b6660',
  margin: '0 0 24px 0',
};

const dimNote: React.CSSProperties = {
  fontSize: '13px',
  color: '#9c9791',
  lineHeight: 1.6,
  margin: '8px 0 40px 0',
};

const inlineCode: React.CSSProperties = {
  background: '#f0eeea',
  borderRadius: '4px',
  padding: '2px 6px',
  fontSize: '13px',
  fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace',
};

const endpointList: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid #e8e6e1',
  borderRadius: '10px',
  overflow: 'hidden',
  marginBottom: '8px',
};

const linkButton: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#6b6660',
  fontSize: '13px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  textDecoration: 'underline',
  padding: 0,
};

const footerLink: React.CSSProperties = {
  color: '#6b6660',
  fontSize: '13px',
  textDecoration: 'none',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  padding: 0,
};

// =============================================================================
// COMPONENTS
// =============================================================================

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '11px',
      fontWeight: 600,
      letterSpacing: '0.1em',
      textTransform: 'uppercase' as const,
      color: '#9c9791',
      marginBottom: '14px',
      marginTop: '48px',
    }}>
      {children}
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre style={{
      background: '#2c2c2c',
      color: '#e8e6e1',
      borderRadius: '10px',
      padding: '18px 22px',
      fontSize: '13px',
      fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace',
      lineHeight: 1.7,
      overflowX: 'auto',
      margin: '0 0 8px 0',
    }}>
      {children}
    </pre>
  );
}

function EP({ method, path, desc, auth }: { method: string; path: string; desc: string; auth?: boolean }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'baseline',
      gap: '10px',
      padding: '10px 16px',
      borderBottom: '1px solid #e8e6e1',
      fontSize: '14px',
    }}>
      <span style={{
        fontSize: '12px',
        fontWeight: 600,
        color: method === 'GET' ? '#2d8a4e' : '#1a1917',
        fontFamily: 'ui-monospace, monospace',
        minWidth: '36px',
      }}>
        {method}
      </span>
      <span style={{ fontFamily: 'ui-monospace, monospace', color: '#1a1917', fontWeight: 500 }}>{path}</span>
      {auth && (
        <span style={{ fontSize: '11px', color: '#9c9791', background: '#f0eeea', padding: '1px 6px', borderRadius: '4px' }}>key</span>
      )}
      <span style={{ color: '#9c9791', marginLeft: 'auto', textAlign: 'right' }}>{desc}</span>
    </div>
  );
}

function AppCard({ name, href, desc, placeholder }: { name: string; href?: string; desc: string; placeholder?: boolean }) {
  return (
    <div style={{
      background: placeholder ? 'transparent' : '#ffffff',
      border: `1px ${placeholder ? 'dashed' : 'solid'} #e8e6e1`,
      borderRadius: '12px',
      padding: '20px 24px',
    }}>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" style={{
          fontSize: '15px', fontWeight: 500, color: '#1a1917', textDecoration: 'none',
        }}>
          {name} &nearr;
        </a>
      ) : (
        <span style={{ fontSize: '15px', fontWeight: 500, color: placeholder ? '#9c9791' : '#1a1917' }}>
          {name}
        </span>
      )}
      <p style={{ fontSize: '14px', color: '#6b6660', lineHeight: 1.6, margin: '8px 0 0' }}>{desc}</p>
    </div>
  );
}
