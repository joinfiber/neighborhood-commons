import { useState, useEffect } from 'react';
import { loginColors } from '../lib/styles';

interface LandingScreenProps {
  onShowLogin: () => void;
  onShowDevelopers: () => void;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const lc = {
  ...loginColors,
  link: '#d4c9b4',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LandingScreen({ onShowLogin, onShowDevelopers }: LandingScreenProps) {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 820);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 820);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const mobile = isMobile;

  return (
    <div style={{
      minHeight: '100vh',
      background: lc.bg,
      color: lc.text,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Ambient glow */}
      <div style={{
        position: 'fixed',
        top: '-300px',
        left: '50%',
        transform: 'translateX(-50%)',
        width: '900px',
        height: '900px',
        borderRadius: '50%',
        background: `radial-gradient(circle, ${lc.accent}0A 0%, transparent 70%)`,
        pointerEvents: 'none',
        zIndex: 0,
        animation: 'drift 22s ease-in-out infinite',
      }} />

      {/* Content */}
      <div style={{
        position: 'relative',
        zIndex: 1,
        width: '100%',
        maxWidth: '680px',
        padding: mobile ? '64px 28px 80px' : '120px 32px 120px',
      }}>

        {/* ── Hero ────────────────────────────────────────────────────── */}
        <header style={{ marginBottom: mobile ? '80px' : '120px' }}>
          <div style={{
            fontSize: '11px',
            fontWeight: 400,
            letterSpacing: '0.18em',
            textTransform: 'uppercase' as const,
            color: lc.accent,
            marginBottom: '32px',
          }}>
            neighborhood commons
          </div>

          <h1 style={{
            fontSize: mobile ? '32px' : '46px',
            fontWeight: 300,
            lineHeight: 1.15,
            color: lc.cream,
            margin: '0 0 40px 0',
            letterSpacing: '-0.02em',
          }}>
            A public database of<br />neighborhood events.
          </h1>

          <p style={{
            fontSize: mobile ? '16px' : '18px',
            lineHeight: 1.7,
            color: lc.text,
            maxWidth: '540px',
            margin: 0,
          }}>
            This is the Neighborhood Commons. It's open infrastructure maintained by <a href="https://joinfiber.app" style={linkStyle}>Fiber</a> and available for use by all. The data is ungated and you may consume it as you wish. To contribute, create an API key and get in touch. Together is how we rise.
          </p>
        </header>

        {/* ── The data ────────────────────────────────────────────────── */}
        <Section title="What's in the data" mobile={mobile}>
          <p style={prose}>
            An event is a public fact. Something happens, somewhere, at some time. The Commons stores the essentials and serves them to anyone who asks.
          </p>
          <div style={{
            display: 'grid',
            gridTemplateColumns: mobile ? '1fr' : '1fr 1fr',
            gap: '14px 40px',
            marginTop: '28px',
          }}>
            {[
              ['What', 'Name and description'],
              ['Where', 'Venue, address, coordinates'],
              ['When', 'Start time, end time, timezone'],
              ['How much', 'Free, $10, $5–15'],
              ['Category', 'One of 20 structured types'],
              ['Photo', 'Cover image, re-encoded and hosted'],
              ['Recurrence', 'Weekly, monthly, custom patterns'],
              ['Tags', 'Access, vibe, format descriptors'],
            ].map(([label, desc]) => (
              <div key={label} style={{ display: 'flex', gap: '12px', padding: '4px 0' }}>
                <span style={{ color: lc.accent, fontSize: '14px', lineHeight: '22px', flexShrink: 0, width: '96px', fontWeight: 500 }}>{label}</span>
                <span style={{ color: lc.muted, fontSize: '14px', lineHeight: '22px' }}>{desc}</span>
              </div>
            ))}
          </div>
          <p style={{ ...prose, marginTop: '28px', color: lc.dim, fontSize: '14px' }}>
            Every event response is self-contained. No joins, no implicit knowledge, no extra calls. One request, the full picture.
          </p>
        </Section>

        {/* ── Expressions ─────────────────────────────────────────────── */}
        <Section title="Expressions of the Commons" mobile={mobile}>
          <p style={prose}>
            The data is open and the use cases are unlimited. These are some of the ways it's already being put to work — each a different vision for what neighborhood event data can become.
          </p>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            marginTop: '28px',
          }}>
            <AppExample
              name="merrie.co"
              href="https://merrie.co"
              desc="One vision for what to do with Commons data — and the easiest way for non-developers to interact with it. Curators discover and organize events. Venue pages are built automatically as data flows in. And soon, lightweight tools for groups and their organizers. Built for and by Philadelphia, the place."
            />
            <AppExample
              name="Fiber"
              href="https://joinfiber.app"
              desc="A different expression entirely. A mobile app and website for social event discovery — browse feeds, share plans with friends, find what's on tonight. Same underlying data, different experience."
            />
            <AppExample
              name="Yours"
              desc="A nightlife guide. A community calendar. A civic dashboard. A newsletter. A digital sign in a coffee shop window. Whatever your audience, the data is here. Clone the repo and build your own commons — or build on ours. Both are welcome."
              placeholder
            />
          </div>
        </Section>

        {/* ── Read ────────────────────────────────────────────────────── */}
        <Section title="Read the data" mobile={mobile}>
          <p style={prose}>
            No account needed. No API key needed. Hit the endpoint and go.
          </p>
          <CodeBlock>{`GET https://commons.joinfiber.app/api/v1/events

# Filter by category
GET /api/v1/events?category=live-music

# Search near a location
GET /api/v1/events?near=39.97,-75.14&radius_km=2

# Full-text search
GET /api/v1/events?q=karaoke`}</CodeBlock>
          <p style={{ ...prose, marginTop: '20px' }}>
            Also available as <InlineCode>events.ics</InlineCode> (iCal) and <InlineCode>events.rss</InlineCode> (RSS). Rate limit is 1,000 requests per hour — generous for any app, and free forever.
          </p>
          <div style={{ marginTop: '20px' }}>
            <button
              type="button"
              onClick={onShowDevelopers}
              style={ctaSecondary}
            >
              Full API documentation
            </button>
          </div>
        </Section>

        {/* ── Contribute ──────────────────────────────────────────────── */}
        <Section title="Contribute data" mobile={mobile}>
          <p style={prose}>
            If you produce event data — you're a venue, a promoter, a community organizer, a scraper of public listings, a builder of tools — you can push events into the Commons. The data becomes part of the public record, available to every app in the ecosystem.
          </p>
          <p style={prose}>
            Write access requires an API key, and keys are issued after a human review. We do this because the Commons is a shared resource: every event published here flows to every downstream consumer. Data quality matters.
          </p>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            marginTop: '28px',
          }}>
            {[
              ['Apply for a key', 'Describe your use case. We review within a few days.'],
              ['Start at pending', 'Your events enter a review queue until we verify you.'],
              ['Get verified', 'Events auto-publish. Higher rate limits. Full access.'],
            ].map(([step, desc], i) => (
              <div key={i} style={{
                display: 'flex',
                gap: '16px',
                alignItems: 'flex-start',
              }}>
                <span style={{
                  color: lc.accent,
                  fontSize: '13px',
                  fontWeight: 600,
                  lineHeight: '24px',
                  flexShrink: 0,
                  width: '20px',
                  textAlign: 'center',
                }}>{i + 1}</span>
                <div>
                  <span style={{ color: lc.cream, fontSize: '15px', fontWeight: 500 }}>{step}</span>
                  <span style={{ color: lc.muted, fontSize: '15px' }}> — {desc}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* ── Why ─────────────────────────────────────────────────────── */}
        <Section title="Why this exists" mobile={mobile}>
          <p style={prose}>
            Events are public facts. A band plays at a bar on Thursday. A yoga class meets in the park on Saturday mornings. A market opens on the first Sunday of every month. These are not opinions. They are not proprietary. They are things that happen in the world, and anyone should be able to know about them.
          </p>
          <p style={prose}>
            Today, this data is scattered across Instagram stories, PDF calendars, word of mouth, and a dozen siloed apps that each have a fraction of the picture. The Neighborhood Commons is a bet that a single, open, well-structured dataset — maintained by the people closest to the facts — is better for everyone. Better for the apps. Better for the neighborhoods. Better for the people trying to find something to do tonight.
          </p>
          <p style={{ ...prose, color: lc.dim }}>
            The Commons is thin on purpose. It stores data and serves it. It doesn't editorialize, recommend, or curate. Those are the concerns of the apps that build on top. The Commons is plumbing — and good plumbing doesn't change with the winds.
          </p>
        </Section>

        {/* ── Footer ──────────────────────────────────────────────────── */}
        <footer style={{
          marginTop: mobile ? '40px' : '64px',
          paddingTop: '40px',
          borderTop: `1px solid ${lc.border}`,
          display: 'flex',
          flexWrap: 'wrap',
          gap: '12px 32px',
          alignItems: 'center',
        }}>
          <a href="#/developers" onClick={(e) => { e.preventDefault(); onShowDevelopers(); }} style={footerLink}>
            API docs
          </a>
          <a href="https://github.com/The-Relational-Technology-Project/neighborhood-api" style={footerLink} target="_blank" rel="noopener noreferrer">
            Neighborhood API spec
          </a>
          <a href="#/terms" style={footerLink}>
            Terms
          </a>
          <button
            type="button"
            onClick={onShowLogin}
            style={{ ...footerLink, background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit' }}
          >
            Manage events
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ color: lc.dim, fontSize: '12px' }}>
            CC BY 4.0
          </span>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const prose: React.CSSProperties = {
  fontSize: '15px',
  lineHeight: 1.75,
  color: loginColors.text,
  margin: '0 0 14px 0',
};

const linkStyle: React.CSSProperties = {
  color: loginColors.cream,
  textDecoration: 'underline',
  textDecorationColor: `${loginColors.cream}30`,
  textUnderlineOffset: '3px',
};

const footerLink: React.CSSProperties = {
  color: loginColors.muted,
  fontSize: '13px',
  textDecoration: 'none',
};

const ctaSecondary: React.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${loginColors.border}`,
  borderRadius: '8px',
  color: loginColors.cream,
  fontSize: '14px',
  fontWeight: 400,
  padding: '11px 22px',
  cursor: 'pointer',
  transition: 'border-color 0.15s',
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Section({ title, children, mobile }: { title: string; children: React.ReactNode; mobile: boolean }) {
  return (
    <section style={{ marginBottom: mobile ? '72px' : '96px' }}>
      <h2 style={{
        fontSize: '11px',
        fontWeight: 400,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color: loginColors.accent,
        marginBottom: '28px',
      }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function AppExample({ name, href, desc, placeholder }: { name: string; href?: string; desc: string; placeholder?: boolean }) {
  return (
    <div style={{
      background: loginColors.card,
      border: `1px solid ${placeholder ? `${loginColors.border}80` : loginColors.border}`,
      borderRadius: '12px',
      padding: '20px 24px',
      borderStyle: placeholder ? 'dashed' : 'solid',
    }}>
      <div style={{ marginBottom: '8px' }}>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: loginColors.cream, fontSize: '16px', fontWeight: 500, textDecoration: 'none', letterSpacing: '-0.01em' }}>
            {name} <span style={{ color: loginColors.dim, fontSize: '12px', verticalAlign: '1px' }}>&#8599;</span>
          </a>
        ) : (
          <span style={{ color: placeholder ? loginColors.muted : loginColors.cream, fontSize: '16px', fontWeight: 500, fontStyle: placeholder ? 'italic' : 'normal', letterSpacing: '-0.01em' }}>
            {name}
          </span>
        )}
      </div>
      <p style={{ color: loginColors.muted, fontSize: '14px', lineHeight: 1.65, margin: 0 }}>{desc}</p>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre style={{
      background: '#0a0a09',
      border: `1px solid ${loginColors.border}`,
      borderRadius: '10px',
      padding: '20px 24px',
      fontSize: '13px',
      lineHeight: 1.7,
      color: loginColors.muted,
      overflow: 'auto',
      margin: '16px 0 0 0',
      fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace',
    }}>
      {children}
    </pre>
  );
}

function InlineCode({ children }: { children: string }) {
  return (
    <code style={{
      background: '#0a0a09',
      border: `1px solid ${loginColors.border}`,
      borderRadius: '4px',
      padding: '2px 7px',
      fontSize: '13px',
      fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace',
      color: loginColors.muted,
    }}>
      {children}
    </code>
  );
}
