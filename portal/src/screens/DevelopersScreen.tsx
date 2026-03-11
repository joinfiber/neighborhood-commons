import { styles, colors } from '../lib/styles';

interface DevelopersScreenProps {
  onBack: () => void;
}

const API_BASE = 'https://api.joinfiber.app';

const EXAMPLE_RESPONSE = `{
  "meta": {
    "total": 42,
    "limit": 50,
    "offset": 0,
    "publisher": "fiber",
    "region": "philadelphia",
    "spec": "neighborhood-api-v0.2"
  },
  "events": [
    {
      "id": "a1b2c3d4-...",
      "name": "Jazz Night at South",
      "start": "2026-03-14T19:00:00-04:00",
      "end": "2026-03-14T22:00:00-04:00",
      "description": "Live jazz trio...",
      "category": ["live-music"],
      "place_id": "ChIJ...",
      "location": {
        "name": "South Jazz Kitchen",
        "address": "600 N Broad St, Philadelphia",
        "lat": 39.9632,
        "lng": -75.1551
      },
      "url": "https://example.com/tickets",
      "images": ["https://..."],
      "organizer": {
        "name": "South Jazz Kitchen",
        "phone": null
      },
      "cost": "Free",
      "recurrence": { "rrule": "FREQ=WEEKLY" },
      "source": {
        "publisher": "fiber",
        "collected_at": "2026-03-10T12:00:00Z",
        "method": "portal",
        "license": "free-use-with-attribution"
      }
    }
  ]
}`;

const WEBHOOK_PAYLOAD = `{
  "event_type": "event.created",
  "event": {
    "id": "a1b2c3d4-...",
    "name": "Jazz Night at South",
    "start": "2026-03-14T19:00:00-04:00",
    ...
  },
  "timestamp": "2026-03-14T12:00:00.000Z",
  "delivery_id": "42"
}`;

const VERIFY_NODE = `const crypto = require('crypto');

function verifyWebhookSignature(body, signature, secret) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(body))
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// In your webhook handler:
app.post('/webhooks', (req, res) => {
  const sig = req.headers['x-fiber-signature'];
  if (!verifyWebhookSignature(req.body, sig, YOUR_SECRET)) {
    return res.status(401).send('Invalid signature');
  }
  // Process the event...
  res.status(200).send('OK');
});`;

const VERIFY_PYTHON = `import hmac
import hashlib
import json

def verify_webhook(body, signature, secret):
    expected = 'sha256=' + hmac.new(
        secret.encode(),
        json.dumps(body).encode(),
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)

# In your webhook handler:
@app.route('/webhooks', methods=['POST'])
def handle_webhook():
    sig = request.headers.get('X-Fiber-Signature')
    if not verify_webhook(request.json, sig, YOUR_SECRET):
        abort(401)
    # Process the event...
    return 'OK', 200`;

const PARAMS = [
  { name: 'start_after', type: 'date', desc: 'Events on or after this date (YYYY-MM-DD)' },
  { name: 'start_before', type: 'date', desc: 'Events before this date (YYYY-MM-DD)' },
  { name: 'category', type: 'string', desc: 'Filter by category slug (e.g., live-music, comedy)' },
  { name: 'q', type: 'string', desc: 'Text search in title and description' },
  { name: 'near', type: 'string', desc: 'Geo filter center point: "lat,lng" (e.g., 39.95,-75.16)' },
  { name: 'radius_km', type: 'number', desc: 'Radius from near point in km (0.1-100, default 10)' },
  { name: 'limit', type: 'number', desc: 'Results per page (1-200, default 50)' },
  { name: 'offset', type: 'number', desc: 'Pagination offset (default 0)' },
];

const codeStyle: React.CSSProperties = {
  background: colors.bg,
  border: `1px solid ${colors.border}`,
  borderRadius: '8px',
  padding: '16px',
  fontSize: '12px',
  fontFamily: 'monospace',
  color: colors.text,
  overflowX: 'auto',
  whiteSpace: 'pre',
  lineHeight: 1.5,
};

const sectionHeading: React.CSSProperties = {
  fontSize: '16px',
  fontWeight: 500,
  color: colors.cream,
  marginBottom: '12px',
};

const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  color: colors.dim,
  marginBottom: '6px',
};

function Endpoint({ method, path, desc, auth }: { method: string; path: string; desc: string; auth?: string }) {
  return (
    <div style={{ ...styles.card, marginBottom: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
        <span style={{
          fontSize: '11px',
          fontWeight: 600,
          color: method === 'GET' ? '#4ade80' : method === 'POST' ? colors.amber : '#60a5fa',
          fontFamily: 'monospace',
        }}>
          {method}
        </span>
        <span style={{ fontSize: '13px', fontFamily: 'monospace', color: colors.cream }}>{path}</span>
        {auth && (
          <span style={{ fontSize: '10px', color: colors.dim, background: colors.bg, padding: '2px 6px', borderRadius: '4px' }}>
            {auth}
          </span>
        )}
      </div>
      <div style={{ fontSize: '13px', color: colors.muted }}>{desc}</div>
    </div>
  );
}

function Section({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <div id={id} style={{ marginBottom: '40px' }}>
      <h2 style={sectionHeading}>{title}</h2>
      {children}
    </div>
  );
}

export function DevelopersScreen({ onBack }: DevelopersScreenProps) {
  return (
    <div style={styles.page}>
      <div style={styles.ambientGlow} />
      <div style={styles.contentWide} className="fade-up">
        {/* Header */}
        <div style={{ marginBottom: '32px' }}>
          <button type="button" style={{ ...styles.buttonText, marginBottom: '16px' }} onClick={onBack}>← Back to login</button>
          <h1 style={{ fontSize: '28px', fontWeight: 300, color: colors.cream, letterSpacing: '0.04em', marginBottom: '8px' }}>
            Build with Fiber Events
          </h1>
          <p style={{ fontSize: '15px', color: colors.muted, lineHeight: 1.6 }}>
            Free, structured event data for Philadelphia. No API key required for basic access — register for one to unlock webhooks.
          </p>
        </div>

        {/* Quick Start */}
        <Section title="Quick Start" id="quick-start">
          <div style={codeStyle}>
            {`# No API key needed — just fetch events
curl "${API_BASE}/api/v1/events?limit=5"

# With an API key (required for webhooks)
curl -H "X-API-Key: fib_..." "${API_BASE}/api/v1/events?limit=5"`}
          </div>
        </Section>

        {/* Get an API Key */}
        <Section title="Get an API Key" id="api-key">
          <div style={styles.card}>
            <p style={{ margin: '0 0 16px 0', fontSize: '14px', color: colors.text, lineHeight: 1.7 }}>
              Register with your email to get an API key. We'll send a verification code — no password needed.
            </p>

            <div style={labelStyle}>Step 1: Request a verification code</div>
            <div style={{ ...codeStyle, marginBottom: '16px' }}>
              {`curl -X POST ${API_BASE}/api/v1/developers/register/send-otp \\
  -H "Content-Type: application/json" \\
  -d '{"email": "you@example.com"}'`}
            </div>

            <div style={labelStyle}>Step 2: Verify and get your key</div>
            <div style={{ ...codeStyle, marginBottom: '16px' }}>
              {`curl -X POST ${API_BASE}/api/v1/developers/register/verify-otp \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "you@example.com",
    "token": "123456",
    "name": "My App Name"
  }'`}
            </div>

            <div style={{ background: colors.bg, border: `1px solid ${colors.amber}33`, borderRadius: '8px', padding: '12px', fontSize: '13px', color: colors.amber }}>
              Save your <strong>raw_key</strong> immediately — it will not be shown again. If you lose it, use the key rotation endpoint to get a new one.
            </div>
          </div>

          <div style={{ ...styles.card, marginTop: '12px', fontSize: '13px', color: colors.muted }}>
            Rate limit: <strong style={{ color: colors.cream }}>1,000 requests/hour</strong> per API key or IP address.
          </div>
        </Section>

        {/* Authentication */}
        <Section title="Authentication" id="auth">
          <div style={styles.card}>
            <p style={{ margin: '0 0 12px 0', fontSize: '14px', color: colors.text, lineHeight: 1.7 }}>
              Pass your API key in the <code style={{ color: colors.amber, fontSize: '13px' }}>X-API-Key</code> header.
              Rate limit is 1,000 requests/hour (per API key or IP). An API key is required for webhooks.
            </p>
            <div style={codeStyle}>
              {`curl -H "X-API-Key: fib_a1b2c3d4e5f6..." \\
  "${API_BASE}/api/v1/events?limit=10"`}
            </div>
          </div>
        </Section>

        {/* Event Endpoints */}
        <Section title="Event Endpoints" id="events">
          <Endpoint method="GET" path="/api/v1/events" desc="List upcoming published events with pagination and filtering." />
          <Endpoint method="GET" path="/api/v1/events/:id" desc="Get a single event by ID." />
          <Endpoint method="GET" path="/api/v1/events.ics" desc="iCalendar feed — subscribe from any calendar app." />
          <Endpoint method="GET" path="/api/v1/events.rss" desc="RSS 2.0 feed for newsletters and aggregators." />
          <Endpoint method="GET" path="/api/v1/events/terms" desc="Usage terms and rate limit info." />
          <Endpoint method="GET" path="/api/v1/meta" desc="Feed metadata: stewards, data sources, supported resources." />
          <Endpoint method="GET" path="/.well-known/neighborhood" desc="API discovery endpoint (Neighborhood API v0.2 spec)." />
        </Section>

        {/* Developer Endpoints */}
        <Section title="Developer Endpoints" id="developer-endpoints">
          <Endpoint method="POST" path="/api/v1/developers/register/send-otp" desc="Send a verification code to register for an API key." />
          <Endpoint method="POST" path="/api/v1/developers/register/verify-otp" desc="Verify code and receive your API key." />
          <Endpoint method="GET" path="/api/v1/developers/me" desc="Get your API key info, webhook count, and today's usage." auth="API Key" />
          <Endpoint method="GET" path="/api/v1/developers/usage" desc="Usage analytics: daily request counts and tier info." auth="API Key" />
          <Endpoint method="POST" path="/api/v1/developers/keys/rotate" desc="Rotate your API key (requires re-verifying email via OTP)." auth="API Key" />
        </Section>

        {/* Webhook Endpoints */}
        <Section title="Webhook Endpoints" id="webhook-endpoints">
          <Endpoint method="POST" path="/api/v1/webhooks" desc="Create a webhook subscription. Returns the signing secret once." auth="API Key" />
          <Endpoint method="GET" path="/api/v1/webhooks" desc="List your webhook subscriptions." auth="API Key" />
          <Endpoint method="PATCH" path="/api/v1/webhooks/:id" desc="Update URL, event types, or pause/resume." auth="API Key" />
          <Endpoint method="DELETE" path="/api/v1/webhooks/:id" desc="Delete a webhook subscription." auth="API Key" />
          <Endpoint method="POST" path="/api/v1/webhooks/:id/test" desc="Send a test delivery to verify your endpoint." auth="API Key" />
          <Endpoint method="GET" path="/api/v1/webhooks/:id/deliveries" desc="View delivery history for a subscription." auth="API Key" />
        </Section>

        {/* Parameters */}
        <Section title="Event Query Parameters" id="params">
          <div style={styles.card}>
            {PARAMS.map((p, i) => (
              <div key={p.name} style={{
                display: 'grid',
                gridTemplateColumns: '120px 60px 1fr',
                gap: '12px',
                padding: '8px 0',
                borderBottom: i < PARAMS.length - 1 ? `1px solid ${colors.border}` : 'none',
                fontSize: '13px',
              }}>
                <span style={{ fontFamily: 'monospace', color: colors.amber }}>{p.name}</span>
                <span style={{ color: colors.dim }}>{p.type}</span>
                <span style={{ color: colors.muted }}>{p.desc}</span>
              </div>
            ))}
          </div>
        </Section>

        {/* Example Response */}
        <Section title="Example Event Response" id="example">
          <div style={codeStyle}>{EXAMPLE_RESPONSE}</div>
        </Section>

        {/* Webhooks Guide */}
        <Section title="Webhooks" id="webhooks">
          <div style={styles.card}>
            <p style={{ margin: '0 0 16px 0', fontSize: '14px', color: colors.text, lineHeight: 1.7 }}>
              Subscribe to real-time notifications when events are created, updated, or deleted.
              Fiber will POST a signed JSON payload to your HTTPS endpoint.
            </p>

            <div style={labelStyle}>Event types</div>
            <div style={{ marginBottom: '16px', fontSize: '13px', color: colors.muted }}>
              <code style={{ color: colors.amber }}>event.created</code> ·{' '}
              <code style={{ color: colors.amber }}>event.updated</code> ·{' '}
              <code style={{ color: colors.amber }}>event.deleted</code>
            </div>

            <div style={labelStyle}>Create a subscription</div>
            <div style={{ ...codeStyle, marginBottom: '16px' }}>
              {`curl -X POST ${API_BASE}/api/v1/webhooks \\
  -H "X-API-Key: fib_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://yourapp.com/webhooks/fiber",
    "event_types": ["event.created", "event.updated"]
  }'`}
            </div>

            <div style={{ background: colors.bg, border: `1px solid ${colors.amber}33`, borderRadius: '8px', padding: '12px', fontSize: '13px', color: colors.amber, marginBottom: '16px' }}>
              Save the <strong>signing_secret</strong> from the response — it will not be shown again.
              Use it to verify that incoming webhooks are actually from Fiber.
            </div>

            <div style={labelStyle}>Webhook payload</div>
            <div style={{ ...codeStyle, marginBottom: '16px' }}>
              {WEBHOOK_PAYLOAD}
            </div>
            <div style={{ fontSize: '12px', color: colors.dim, marginBottom: '16px' }}>
              Headers include:{' '}
              <code style={{ color: colors.muted }}>X-Fiber-Signature</code>,{' '}
              <code style={{ color: colors.muted }}>X-Fiber-Event</code>,{' '}
              <code style={{ color: colors.muted }}>Content-Type: application/json</code>
            </div>

            <div style={labelStyle}>Delivery behavior</div>
            <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: '13px', color: colors.muted, lineHeight: 1.8 }}>
              <li>Your endpoint must respond with <strong style={{ color: colors.cream }}>2xx</strong> within 10 seconds</li>
              <li>Failed deliveries retry 3 times with backoff: 1 min, 5 min, 25 min</li>
              <li>After <strong style={{ color: colors.cream }}>10 consecutive failures</strong>, the subscription is auto-disabled</li>
              <li>Re-enable with <code style={{ color: colors.amber }}>PATCH /api/v1/webhooks/:id</code> {'{ "status": "active" }'}</li>
            </ul>
          </div>
        </Section>

        {/* Signature Verification */}
        <Section title="Webhook Signature Verification" id="signature">
          <div style={styles.card}>
            <p style={{ margin: '0 0 16px 0', fontSize: '14px', color: colors.text, lineHeight: 1.7 }}>
              Every webhook includes an <code style={{ color: colors.amber, fontSize: '13px' }}>X-Fiber-Signature</code> header.
              Verify it with your signing secret to ensure the payload hasn't been tampered with.
            </p>

            <div style={labelStyle}>Node.js</div>
            <div style={{ ...codeStyle, marginBottom: '16px' }}>{VERIFY_NODE}</div>

            <div style={labelStyle}>Python</div>
            <div style={codeStyle}>{VERIFY_PYTHON}</div>
          </div>
        </Section>

        {/* Delivery History */}
        <Section title="Delivery History" id="delivery-history">
          <div style={styles.card}>
            <p style={{ margin: '0 0 12px 0', fontSize: '14px', color: colors.text, lineHeight: 1.7 }}>
              Debug webhook issues by viewing delivery history for any subscription.
            </p>
            <div style={codeStyle}>
              {`curl -H "X-API-Key: fib_..." \\
  "${API_BASE}/api/v1/webhooks/{subscription_id}/deliveries?limit=10"

# Filter by status
curl -H "X-API-Key: fib_..." \\
  "${API_BASE}/api/v1/webhooks/{subscription_id}/deliveries?status=failed"`}
            </div>
            <div style={{ marginTop: '12px', fontSize: '13px', color: colors.muted }}>
              Delivery statuses:{' '}
              <code style={{ color: '#4ade80' }}>delivered</code> ·{' '}
              <code style={{ color: colors.amber }}>pending</code> ·{' '}
              <code style={{ color: colors.amber }}>retrying</code> ·{' '}
              <code style={{ color: colors.error }}>failed</code>
            </div>
            <div style={{ marginTop: '4px', fontSize: '12px', color: colors.dim }}>
              Delivery logs are retained for 30 days.
            </div>
          </div>
        </Section>

        {/* Usage Analytics */}
        <Section title="Usage Analytics" id="usage">
          <div style={styles.card}>
            <p style={{ margin: '0 0 12px 0', fontSize: '14px', color: colors.text, lineHeight: 1.7 }}>
              Track your API usage and see daily request counts.
            </p>
            <div style={codeStyle}>
              {`curl -H "X-API-Key: fib_..." \\
  "${API_BASE}/api/v1/developers/usage?days=7"

# Response:
{
  "usage": {
    "today": 142,
    "last_7_days": 3200,
    "last_30_days": 12500,
    "daily": [
      { "date": "2026-03-08", "requests": 142 },
      { "date": "2026-03-07", "requests": 520 }
    ]
  },
  "limits": {
    "tier": "free",
    "rate_limit_per_hour": 1000
  }
}`}
            </div>
          </div>
        </Section>

        {/* Event Schema */}
        <Section title="Event Schema" id="schema">
          <div style={styles.card}>
            {[
              { name: 'id', type: 'string', desc: 'UUID' },
              { name: 'name', type: 'string', desc: 'Event title' },
              { name: 'start', type: 'string', desc: 'ISO 8601 with timezone offset' },
              { name: 'end', type: 'string|null', desc: 'End time (null if open-ended)' },
              { name: 'description', type: 'string|null', desc: 'Plain text, newlines preserved' },
              { name: 'category', type: 'string[]', desc: 'Slugified category (e.g., ["live-music"])' },
              { name: 'place_id', type: 'string|null', desc: 'Google Places ID for the venue' },
              { name: 'location', type: 'object', desc: '{ name, address, lat, lng }' },
              { name: 'url', type: 'string|null', desc: 'Ticket or event page URL' },
              { name: 'images', type: 'string[]', desc: 'Image URLs (may be empty)' },
              { name: 'organizer', type: 'object', desc: '{ name }' },
              { name: 'cost', type: 'string|null', desc: '"Free", "$10", "$5-15", etc.' },
              { name: 'recurrence', type: 'object|null', desc: '{ rrule: "FREQ=WEEKLY" } or null' },
              { name: 'source', type: 'object', desc: '{ publisher, collected_at, method, license }' },
            ].map((f, i, arr) => (
              <div key={f.name} style={{
                display: 'grid',
                gridTemplateColumns: '110px 90px 1fr',
                gap: '12px',
                padding: '8px 0',
                borderBottom: i < arr.length - 1 ? `1px solid ${colors.border}` : 'none',
                fontSize: '13px',
              }}>
                <span style={{ fontFamily: 'monospace', color: colors.amber }}>{f.name}</span>
                <span style={{ color: colors.dim }}>{f.type}</span>
                <span style={{ color: colors.muted }}>{f.desc}</span>
              </div>
            ))}
          </div>
        </Section>

        {/* Error Codes */}
        <Section title="Error Responses" id="errors">
          <div style={styles.card}>
            {[
              { code: '401', desc: 'Invalid or missing API key (for key-required endpoints)' },
              { code: '404', desc: 'Resource not found' },
              { code: '409', desc: 'API key already exists for this email' },
              { code: '429', desc: 'Rate limit exceeded' },
              { code: '500', desc: 'Server error' },
            ].map((e, i, arr) => (
              <div key={e.code} style={{
                display: 'flex',
                gap: '16px',
                padding: '8px 0',
                borderBottom: i < arr.length - 1 ? `1px solid ${colors.border}` : 'none',
                fontSize: '13px',
              }}>
                <span style={{ fontFamily: 'monospace', color: colors.error, minWidth: '40px' }}>{e.code}</span>
                <span style={{ color: colors.muted }}>{e.desc}</span>
              </div>
            ))}
            <div style={{ marginTop: '8px', fontSize: '12px', color: colors.dim }}>
              All errors return: {'{ "error": { "code": "...", "message": "..." } }'}
            </div>
          </div>
        </Section>

        {/* Terms */}
        <Section title="Terms" id="terms">
          <div style={styles.card}>
            <p style={{ margin: '0 0 12px 0', fontSize: '14px', color: colors.text, lineHeight: 1.7 }}>
              This data is free to use. Please attribute Fiber where you use it.
              Don't use it for ads or tracking. If you're building something cool with it,
              we'd love to hear about it.
            </p>
            <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: '13px', color: colors.muted, lineHeight: 1.8 }}>
              <li>Attribution: Display <strong style={{ color: colors.cream }}>"Powered by Fiber"</strong> somewhere visible</li>
              <li>Rate limit: <strong style={{ color: colors.cream }}>1,000 requests/hour</strong> per API key or IP</li>
              <li>No surveillance, tracking, or profiling of event attendees</li>
              <li>No reselling the raw data feed. Building products with it is encouraged.</li>
            </ul>
          </div>
        </Section>

        {/* Neighborhood API */}
        <Section title="Neighborhood API v0.2" id="spec">
          <div style={styles.card}>
            <p style={{ margin: '0 0 8px 0', fontSize: '13px', color: colors.muted, lineHeight: 1.6 }}>
              This API follows the{' '}
              <a href="https://github.com/The-Relational-Technology-Project/neighborhood-api"
                style={{ color: colors.amber, textDecoration: 'none' }}
                target="_blank" rel="noopener noreferrer">
                Neighborhood API v0.2 spec
              </a>
              {' '}— an open format for sharing local events, assets, and plans across community tools.
            </p>
            <p style={{ margin: 0, fontSize: '12px', color: colors.dim, lineHeight: 1.6 }}>
              Steward: Fiber · Region: Philadelphia · Resources: events
            </p>
          </div>
        </Section>

        {/* Contact */}
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <p style={{ color: colors.muted, fontSize: '14px', marginBottom: '6px' }}>
            Building something with this data? Need a higher tier?
          </p>
          <p style={{ color: colors.dim, fontSize: '13px' }}>
            We'd love to hear about it — <span style={{ color: colors.amber }}>hello@joinfiber.app</span>
          </p>
        </div>
      </div>
    </div>
  );
}
