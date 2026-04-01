import { useState, useEffect } from 'react';
import { loginColors } from '../lib/styles';

interface LandingScreenProps {
  onShowLogin: () => void;
  onShowDevelopers: () => void;
}

const lc = loginColors;

export function LandingScreen({ onShowLogin, onShowDevelopers }: LandingScreenProps) {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 820);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 820);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const m = isMobile;

  return (
    <div style={{
      minHeight: '100vh',
      background: lc.bg,
      color: lc.text,
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Ambient glow */}
      <div style={{
        position: 'fixed',
        top: '-400px',
        left: '50%',
        transform: 'translateX(-50%)',
        width: '1100px',
        height: '1100px',
        borderRadius: '50%',
        background: `radial-gradient(circle, ${lc.accent}08 0%, transparent 60%)`,
        pointerEvents: 'none',
        zIndex: 0,
        animation: 'drift 22s ease-in-out infinite',
      }} />

      {/* ────────────────────────────────────────────────────────────────
          HERO — owns the first viewport
      ──────────────────────────────────────────────────────────────── */}
      <div style={{
        position: 'relative',
        zIndex: 1,
        minHeight: m ? 'auto' : '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: m ? 'flex-start' : 'center',
        textAlign: 'center',
        padding: m ? '72px 28px 80px' : '0 40px',
      }}>
        <div style={{
          fontSize: '11px',
          fontWeight: 400,
          letterSpacing: '0.22em',
          textTransform: 'uppercase' as const,
          color: lc.accent,
          marginBottom: m ? '28px' : '36px',
        }}>
          neighborhood commons
        </div>

        <h1 style={{
          fontSize: m ? '36px' : '58px',
          fontWeight: 300,
          lineHeight: 1.1,
          color: lc.cream,
          margin: 0,
          letterSpacing: '-0.025em',
          maxWidth: '720px',
        }}>
          A public database of{m ? <br /> : ' '}neighborhood events.
        </h1>

        <p style={{
          fontSize: m ? '16px' : '19px',
          lineHeight: 1.7,
          color: lc.text,
          maxWidth: '520px',
          margin: m ? '32px 0 0' : '40px 0 0',
        }}>
          This is the Neighborhood Commons. It's open infrastructure maintained by{' '}
          <a href="https://joinfiber.app" style={{ color: lc.cream, textDecoration: 'underline', textDecorationColor: `${lc.cream}30`, textUnderlineOffset: '3px' }}>Fiber</a>
          {' '}and available for use by all. The data is ungated and you may consume it as you wish. To contribute, create an API key and get in touch.
        </p>

        <p style={{
          fontSize: m ? '16px' : '19px',
          lineHeight: 1.7,
          color: lc.cream,
          margin: '24px 0 0',
          fontStyle: 'italic',
        }}>
          Common ground for neighborhood data.
        </p>

        {/* Scroll hint */}
        {!m && (
          <div style={{
            position: 'absolute',
            bottom: '40px',
            color: lc.dim,
            fontSize: '12px',
            letterSpacing: '0.1em',
            opacity: 0.5,
          }}>
            &#8595;
          </div>
        )}
      </div>

      {/* ────────────────────────────────────────────────────────────────
          SECTIONS — each panel breathes
      ──────────────────────────────────────────────────────────────── */}

      {/* What's in the data */}
      <Panel mobile={m}>
        <SectionLabel>What's in the data</SectionLabel>
        <p style={prose}>
          An event is a public fact. Something happens, somewhere, at some time. The Commons stores the essentials and serves them to anyone who asks.
        </p>
        <div style={{
          display: 'grid',
          gridTemplateColumns: m ? '1fr' : '1fr 1fr',
          gap: '16px 48px',
          marginTop: '36px',
        }}>
          {[
            ['What', 'Name and description'],
            ['Where', 'Venue, address, coordinates'],
            ['When', 'Start time, end time, timezone'],
            ['How much', 'Free, $10, $5–15'],
            ['Category', 'One of 20 structured types'],
            ['Link', 'Event page, tickets, or listing URL'],
            ['Image', 'Cover photo per event, logo per venue'],
            ['Recurrence', 'Weekly, monthly, custom patterns'],
            ['Tags', 'Access, vibe, format descriptors'],
          ].map(([label, desc]) => (
            <div key={label} style={{ display: 'flex', gap: '14px', padding: '2px 0' }}>
              <span style={{ color: lc.cream, fontSize: '15px', lineHeight: '24px', flexShrink: 0, width: '100px', fontWeight: 500 }}>{label}</span>
              <span style={{ color: lc.muted, fontSize: '15px', lineHeight: '24px' }}>{desc}</span>
            </div>
          ))}
        </div>
        <p style={{ color: lc.dim, fontSize: '14px', lineHeight: 1.7, marginTop: '36px', marginBottom: 0 }}>
          Every event response is self-contained. No joins, no implicit knowledge, no extra calls. One request, the full picture.
        </p>
      </Panel>

      {/* Expressions */}
      <Panel mobile={m} subtle>
        <SectionLabel>Expressions of the Commons</SectionLabel>
        <p style={prose}>
          The data is open and the use cases are unlimited. These are some of the ways it's already being put to work — each a different vision for what neighborhood event data can become.
        </p>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '24px',
          marginTop: '36px',
        }}>
          <AppCard
            name="merrie.co"
            href="https://merrie.co"
            desc="One vision for what to do with Commons data — and the easiest way for non-developers to interact with it. Curators discover and organize events. Venue pages are built automatically as data flows in. And soon, lightweight tools for groups and their organizers. Built for and by Philadelphia, the place."
          />
          <AppCard
            name="Fiber"
            href="https://joinfiber.app"
            desc="A different expression entirely. A mobile app and website for social event discovery — browse feeds, share plans with friends, find what's on tonight. Same underlying data, different experience."
          />
          <AppCard
            name="Yours"
            desc="A nightlife guide. A community calendar. A civic dashboard. A newsletter. A digital sign in a coffee shop window. Whatever your audience, the data is here. Clone the repo and build your own commons — or build on ours. Both are welcome."
            placeholder
          />
        </div>
      </Panel>

      {/* Get Started */}
      <Panel mobile={m}>
        <div style={{ textAlign: 'center', marginBottom: '48px' }}>
          <h2 style={{
            fontSize: m ? '28px' : '36px',
            fontWeight: 300,
            color: lc.cream,
            letterSpacing: '-0.02em',
            margin: '0 0 16px',
          }}>
            Get started
          </h2>
          <p style={{ ...prose, maxWidth: '480px', margin: '0 auto', textAlign: 'center' }}>
            Two ways to participate. Both are free.
          </p>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: m ? '1fr' : '1fr 1fr',
          gap: '24px',
        }}>
          {/* Read */}
          <div style={{
            background: lc.card,
            border: `1px solid ${lc.border}`,
            borderRadius: '14px',
            padding: '28px',
          }}>
            <div style={{ fontSize: '11px', fontWeight: 400, letterSpacing: '0.16em', textTransform: 'uppercase' as const, color: lc.accent, marginBottom: '16px' }}>
              Read
            </div>
            <p style={{ color: lc.cream, fontSize: '17px', fontWeight: 500, margin: '0 0 12px', lineHeight: 1.4 }}>
              Pull event data into your app
            </p>
            <p style={{ ...prose, fontSize: '14px', marginBottom: '20px' }}>
              No account. No API key. No signup. Hit the endpoint and you have structured event data — name, place, time, category, image, recurrence. One request, the full picture.
            </p>
            <pre style={{
              background: '#070706',
              border: `1px solid ${lc.border}`,
              borderRadius: '10px',
              padding: '16px 20px',
              fontSize: '12px',
              lineHeight: 1.7,
              color: lc.muted,
              overflow: 'auto',
              margin: '0 0 16px 0',
              fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace',
            }}>{`curl api.neighborhood-commons.org/api/v1/events

# By category
?category=live-music

# Near a location
?near=39.97,-75.14&radius_km=2`}</pre>
            <p style={{ color: lc.dim, fontSize: '13px', lineHeight: 1.6, margin: 0 }}>
              Also as <code style={inlineCode}>events.ics</code> and <code style={inlineCode}>events.rss</code>. 1,000 requests/hour. Free forever.
            </p>
          </div>

          {/* Write */}
          <div style={{
            background: lc.card,
            border: `1px solid ${lc.border}`,
            borderRadius: '14px',
            padding: '28px',
          }}>
            <div style={{ fontSize: '11px', fontWeight: 400, letterSpacing: '0.16em', textTransform: 'uppercase' as const, color: lc.accent, marginBottom: '16px' }}>
              Contribute
            </div>
            <p style={{ color: lc.cream, fontSize: '17px', fontWeight: 500, margin: '0 0 12px', lineHeight: 1.4 }}>
              Push event data into the Commons
            </p>
            <p style={{ ...prose, fontSize: '14px', marginBottom: '20px' }}>
              Register with your email — no approval, no waiting. You get an API key instantly. Create venues, post events (one-off or recurring), organize them into groups. Your data flows to every app in the ecosystem.
            </p>
            <pre style={{
              background: '#070706',
              border: `1px solid ${lc.border}`,
              borderRadius: '10px',
              padding: '16px 20px',
              fontSize: '12px',
              lineHeight: 1.7,
              color: lc.muted,
              overflow: 'auto',
              margin: '0 0 16px 0',
              fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace',
            }}>{`POST /api/v1/contribute
{
  "name": "Open Mic Night",
  "start": "2026-04-15T19:00:00-04:00",
  "timezone": "America/New_York",
  "category": "open-mic",
  "location": { "name": "The Spot" }
}`}</pre>
            <p style={{ color: lc.dim, fontSize: '13px', lineHeight: 1.6, margin: 0 }}>
              With AI assistance, you can build an app that reads and writes Commons data in under 30 minutes. Point your LLM to <code style={inlineCode}>api.neighborhood-commons.org/llms.txt</code> and go.
            </p>
          </div>
        </div>

        <div style={{ textAlign: 'center', marginTop: '40px' }}>
          <button
            type="button"
            onClick={onShowDevelopers}
            style={{
              background: lc.accent,
              color: '#0f0f0e',
              border: 'none',
              borderRadius: '10px',
              padding: '14px 36px',
              fontSize: '16px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'opacity 0.15s',
            }}
          >
            Get started — it's free
          </button>
        </div>
      </Panel>

      {/* Why this exists */}
      <Panel mobile={m}>
        <SectionLabel>Why this exists</SectionLabel>
        <p style={{ ...prose, fontSize: '16px' }}>
          Events are public facts. A band plays at a bar on Thursday. A yoga class meets in the park on Saturday mornings. A market opens on the first Sunday of every month. These are not opinions. They are not proprietary. They are things that happen in the world, and anyone should be able to know about them.
        </p>
        <p style={{ ...prose, fontSize: '16px' }}>
          Today, this data is scattered across Instagram stories, PDF calendars, word of mouth, and a dozen siloed apps that each have a fraction of the picture. The Neighborhood Commons is a bet that a single, open, well-structured dataset — maintained by the people closest to the facts — is better for everyone. Better for the apps. Better for the neighborhoods. Better for the people trying to find something to do tonight.
        </p>
        <p style={{ ...prose, color: lc.dim, fontSize: '15px', marginBottom: 0 }}>
          The Commons is thin on purpose. It stores data and serves it. It doesn't editorialize, recommend, or curate. Those are the concerns of the apps that build on top. The Commons is plumbing — and good plumbing doesn't change with the winds.
        </p>
      </Panel>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer style={{
        position: 'relative',
        zIndex: 1,
        maxWidth: '680px',
        margin: '0 auto',
        padding: m ? '0 28px 64px' : '0 32px 80px',
      }}>
        <div style={{
          borderTop: `1px solid ${lc.border}`,
          paddingTop: '32px',
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
          <span style={{ color: lc.dim, fontSize: '12px' }}>CC BY 4.0</span>
        </div>
      </footer>
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

const footerLink: React.CSSProperties = {
  color: loginColors.muted,
  fontSize: '13px',
  textDecoration: 'none',
};

const inlineCode: React.CSSProperties = {
  background: '#070706',
  border: `1px solid ${loginColors.border}`,
  borderRadius: '4px',
  padding: '2px 7px',
  fontSize: '13px',
  fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace',
  color: loginColors.muted,
};

// ---------------------------------------------------------------------------
// Layout components
// ---------------------------------------------------------------------------

function Panel({ children, mobile, subtle }: { children: React.ReactNode; mobile: boolean; subtle?: boolean }) {
  return (
    <div style={{
      position: 'relative',
      zIndex: 1,
      background: subtle ? '#121110' : 'transparent',
      padding: mobile ? '64px 28px' : '96px 40px',
    }}>
      <div style={{ maxWidth: '680px', margin: '0 auto' }}>
        {children}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <h2 style={{
      fontSize: '11px',
      fontWeight: 400,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      color: loginColors.accent,
      marginBottom: '32px',
    }}>
      {children}
    </h2>
  );
}

function AppCard({ name, href, desc, placeholder }: { name: string; href?: string; desc: string; placeholder?: boolean }) {
  return (
    <div style={{
      background: loginColors.card,
      border: `1px solid ${placeholder ? `${loginColors.border}80` : loginColors.border}`,
      borderRadius: '14px',
      padding: '24px 28px',
      borderStyle: placeholder ? 'dashed' : 'solid',
    }}>
      <div style={{ marginBottom: '10px' }}>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: loginColors.cream, fontSize: '17px', fontWeight: 500, textDecoration: 'none', letterSpacing: '-0.01em' }}>
            {name} <span style={{ color: loginColors.dim, fontSize: '13px', verticalAlign: '1px' }}>&#8599;</span>
          </a>
        ) : (
          <span style={{ color: placeholder ? loginColors.muted : loginColors.cream, fontSize: '17px', fontWeight: 500, fontStyle: placeholder ? 'italic' : 'normal', letterSpacing: '-0.01em' }}>
            {name}
          </span>
        )}
      </div>
      <p style={{ color: loginColors.muted, fontSize: '14px', lineHeight: 1.7, margin: 0 }}>{desc}</p>
    </div>
  );
}
