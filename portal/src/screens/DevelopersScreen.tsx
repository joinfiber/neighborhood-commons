import { useState } from 'react';
import { styles, colors } from '../lib/styles';

const API_BASE = 'https://commons.joinfiber.app';
const API_URL = import.meta.env.VITE_API_URL || '';

const EXAMPLE_RESPONSE = `{
  "meta": {
    "total": 42,
    "limit": 50,
    "offset": 0,
    "spec": "neighborhood-api-v0.2",
    "license": "CC-BY-4.0"
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
        "name": "South Jazz Kitchen"
      },
      "cost": "Free",
      "recurrence": { "rrule": "FREQ=WEEKLY" },
      "source": {
        "publisher": "South Jazz Kitchen",
        "collected_at": "2026-03-10T12:00:00Z",
        "method": "portal",
        "license": "CC BY 4.0"
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
  const sig = req.headers['x-nc-signature'];
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
    sig = request.headers.get('X-NC-Signature')
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
  fontSize: '14px',
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
  fontSize: '12px',
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
          fontSize: '12px',
          fontWeight: 600,
          color: method === 'GET' ? colors.success : method === 'POST' ? colors.cream : '#60a5fa',
          fontFamily: 'monospace',
        }}>
          {method}
        </span>
        <span style={{ fontSize: '14px', fontFamily: 'monospace', color: colors.cream }}>{path}</span>
        {auth && (
          <span style={{ fontSize: '12px', color: colors.dim, background: colors.bg, padding: '2px 6px', borderRadius: '4px' }}>
            {auth}
          </span>
        )}
      </div>
      <div style={{ fontSize: '14px', color: colors.muted }}>{desc}</div>
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

type RegStep = 'idle' | 'email' | 'verify' | 'done';

function RegisterCard() {
  const [step, setStep] = useState<RegStep>('idle');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [otp, setOtp] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function devFetch<T>(endpoint: string, body: Record<string, string>): Promise<{ data?: T; error?: string }> {
    try {
      const res = await fetch(`${API_URL}/api/v1/developers${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) return { error: json.error?.message || `Request failed (${res.status})` };
      return { data: json };
    } catch {
      return { error: 'Network error — please try again' };
    }
  }

  async function handleSendOtp() {
    setError('');
    setLoading(true);
    const res = await devFetch('/register/send-otp', { email });
    setLoading(false);
    if (res.error) { setError(res.error); return; }
    setStep('verify');
  }

  async function handleVerify() {
    setError('');
    setLoading(true);
    const res = await devFetch<{ api_key: { raw_key: string } }>('/register/verify-otp', { email, token: otp, name });
    setLoading(false);
    if (res.error) { setError(res.error); return; }
    setApiKey(res.data!.api_key.raw_key);
    setStep('done');
  }

  function handleCopy() {
    navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    fontSize: '14px',
    background: colors.bg,
    border: `1px solid ${colors.border}`,
    borderRadius: '8px',
    color: colors.text,
    outline: 'none',
    boxSizing: 'border-box',
  };

  const submitStyle: React.CSSProperties = {
    ...styles.buttonPrimary,
    width: '100%',
    padding: '10px 16px',
    fontSize: '14px',
    cursor: loading ? 'wait' : 'pointer',
    opacity: loading ? 0.7 : 1,
    borderRadius: '8px',
  };

  if (step === 'idle') {
    return (
      <div style={styles.card}>
        <p style={{ margin: '0 0 12px 0', fontSize: '14px', color: colors.text, lineHeight: 1.7 }}>
          Get a free API key for a dedicated rate limit bucket and webhook access.
          No approval required — verify your email and you're in.
        </p>
        <button type="button" onClick={() => setStep('email')} style={{ ...styles.buttonPrimary, fontSize: '14px', padding: '10px 20px', cursor: 'pointer', borderRadius: '8px' }}>
          Get an API Key
        </button>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div style={styles.card}>
        <div style={{ fontSize: '16px', color: colors.success, fontWeight: 500, marginBottom: '12px' }}>
          Your API key is ready
        </div>
        <div style={{
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          borderRadius: '8px',
          padding: '12px',
          fontFamily: 'monospace',
          fontSize: '14px',
          color: colors.cream,
          wordBreak: 'break-all',
          marginBottom: '12px',
        }}>
          {apiKey}
        </div>
        <button type="button" onClick={handleCopy} style={{ ...styles.buttonPrimary, fontSize: '14px', padding: '8px 16px', cursor: 'pointer', borderRadius: '8px' }}>
          {copied ? 'Copied!' : 'Copy to clipboard'}
        </button>
        <div style={{ marginTop: '12px', fontSize: '14px', color: colors.cream }}>
          Save this key now — it will not be shown again.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      {error && (
        <div style={{ background: '#fef2f2', color: colors.error, padding: '8px 12px', borderRadius: '6px', fontSize: '14px', marginBottom: '12px' }}>
          {error}
        </div>
      )}

      {step === 'email' && (
        <form onSubmit={(e) => { e.preventDefault(); void handleSendOtp(); }} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <label style={{ fontSize: '14px', color: colors.muted, display: 'block', marginBottom: '4px' }}>Your email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="dev@example.com" required style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: '14px', color: colors.muted, display: 'block', marginBottom: '4px' }}>App or project name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Neighborhood App" required style={inputStyle} />
          </div>
          <button type="submit" disabled={loading} style={submitStyle}>
            {loading ? 'Sending...' : 'Send verification code'}
          </button>
          <button type="button" onClick={() => { setStep('idle'); setError(''); }} style={{ background: 'none', border: 'none', color: colors.dim, fontSize: '14px', cursor: 'pointer' }}>
            Cancel
          </button>
        </form>
      )}

      {step === 'verify' && (
        <form onSubmit={(e) => { e.preventDefault(); void handleVerify(); }} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <p style={{ margin: 0, fontSize: '14px', color: colors.muted }}>
            We sent a code to <strong style={{ color: colors.cream }}>{email}</strong>
          </p>
          <div>
            <label style={{ fontSize: '14px', color: colors.muted, display: 'block', marginBottom: '4px' }}>Verification code</label>
            <input type="text" value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="12345678" required maxLength={8} style={{ ...inputStyle, letterSpacing: '0.15em', textAlign: 'center', fontSize: '18px' }} />
          </div>
          <button type="submit" disabled={loading} style={submitStyle}>
            {loading ? 'Verifying...' : 'Verify & get key'}
          </button>
          <button type="button" onClick={() => { setStep('email'); setOtp(''); setError(''); }} style={{ background: 'none', border: 'none', color: colors.dim, fontSize: '14px', cursor: 'pointer' }}>
            Back
          </button>
        </form>
      )}
    </div>
  );
}

export function DevelopersScreen() {
  return (
    <>
        {/* Header */}
        <div style={{ marginBottom: '32px' }}>
          <h1 style={{ fontSize: '28px', fontWeight: 300, color: colors.cream, letterSpacing: '0.04em', marginBottom: '8px' }}>
            Build with Neighborhood Commons
          </h1>
          <p style={{ fontSize: '15px', color: colors.muted, lineHeight: 1.6 }}>
            Open neighborhood event data, licensed CC BY 4.0. No API key required — pass one in the X-API-Key header for a dedicated rate limit bucket.
          </p>
        </div>

        {/* Quick Start */}
        <Section title="Quick Start" id="quick-start">
          <div style={codeStyle}>
            {`# No API key needed — just fetch events
curl "${API_BASE}/api/v1/events?limit=5"

# Filter by category and location
curl "${API_BASE}/api/v1/events?category=live-music&near=39.95,-75.16&radius_km=5"

# Subscribe in your calendar
${API_BASE}/api/v1/events.ics`}
          </div>
        </Section>

        {/* Rate Limits */}
        <Section title="Rate Limits" id="rate-limits">
          <div style={styles.card}>
            <p style={{ margin: '0 0 12px 0', fontSize: '14px', color: colors.text, lineHeight: 1.7 }}>
              All access is rate limited to <strong style={{ color: colors.cream }}>1,000 requests/hour</strong> per IP address.
              Pass an optional <code style={{ color: colors.cream, fontSize: '14px' }}>X-API-Key</code> header to get a dedicated rate limit bucket
              (useful if you share an IP with other consumers).
            </p>
            <p style={{ margin: 0, fontSize: '14px', color: colors.muted }}>
              Standard <code style={{ color: colors.cream, fontSize: '14px' }}>RateLimit-*</code> headers are included in every response.
            </p>
          </div>
        </Section>

        {/* Get an API Key */}
        <Section title="Get an API Key" id="register">
          <RegisterCard />
        </Section>

        {/* Manage Your Key */}
        <Section title="Manage Your Key" id="manage-key">
          <Endpoint method="GET" path="/api/v1/developers/me" desc="View your API key info and webhook count." auth="API Key" />
          <Endpoint method="POST" path="/api/v1/developers/keys/rotate" desc="Rotate your API key. Requires email re-verification via OTP." auth="API Key" />
          <div style={styles.card}>
            <div style={labelStyle}>Check your key</div>
            <div style={{ ...codeStyle, marginBottom: '16px' }}>
              {`curl -H "X-API-Key: nc_..." \\
  "${API_BASE}/api/v1/developers/me"`}
            </div>
            <div style={labelStyle}>Rotate a compromised key</div>
            <div style={codeStyle}>
              {`# Step 1: Request OTP (reuses the registration endpoint)
curl -X POST ${API_BASE}/api/v1/developers/register/send-otp \\
  -H "Content-Type: application/json" \\
  -d '{ "email": "your@email.com" }'

# Step 2: Rotate with OTP + current key
curl -X POST ${API_BASE}/api/v1/developers/keys/rotate \\
  -H "X-API-Key: nc_current_key..." \\
  -H "Content-Type: application/json" \\
  -d '{ "email": "your@email.com", "token": "12345678" }'`}
            </div>
            <div style={{ marginTop: '12px', fontSize: '14px', color: colors.dim }}>
              Webhook subscriptions are automatically migrated to the new key.
            </div>
          </div>
        </Section>

        {/* Authentication */}
        <Section title="Authentication" id="auth">
          <div style={styles.card}>
            <p style={{ margin: '0 0 12px 0', fontSize: '14px', color: colors.text, lineHeight: 1.7 }}>
              No authentication required. The API is fully public.
              Optionally pass an API key in the <code style={{ color: colors.cream, fontSize: '14px' }}>X-API-Key</code> header
              for a dedicated rate limit bucket. An API key is required for webhook subscriptions.
            </p>
            <div style={codeStyle}>
              {`# No key needed
curl "${API_BASE}/api/v1/events?limit=10"

# With optional API key
curl -H "X-API-Key: nc_a1b2c3d4e5f6..." \\
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
                fontSize: '14px',
              }}>
                <span style={{ fontFamily: 'monospace', color: colors.cream }}>{p.name}</span>
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
              The server will POST a signed JSON payload to your HTTPS endpoint.
            </p>

            <div style={labelStyle}>Event types</div>
            <div style={{ marginBottom: '16px', fontSize: '14px', color: colors.muted }}>
              <code style={{ color: colors.cream }}>event.created</code> ·{' '}
              <code style={{ color: colors.cream }}>event.updated</code> ·{' '}
              <code style={{ color: colors.cream }}>event.deleted</code>
            </div>

            <div style={labelStyle}>Create a subscription</div>
            <div style={{ ...codeStyle, marginBottom: '16px' }}>
              {`curl -X POST ${API_BASE}/api/v1/webhooks \\
  -H "X-API-Key: nc_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://yourapp.com/webhooks/commons",
    "event_types": ["event.created", "event.updated"]
  }'`}
            </div>

            <div style={{ background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '12px', fontSize: '14px', color: colors.cream, marginBottom: '16px' }}>
              Save the <strong>signing_secret</strong> from the response — it will not be shown again.
              Use it to verify that incoming webhooks are authentic.
            </div>

            <div style={labelStyle}>Webhook payload</div>
            <div style={{ ...codeStyle, marginBottom: '16px' }}>
              {WEBHOOK_PAYLOAD}
            </div>
            <div style={{ fontSize: '14px', color: colors.dim, marginBottom: '16px' }}>
              Headers include:{' '}
              <code style={{ color: colors.muted }}>X-NC-Signature</code>,{' '}
              <code style={{ color: colors.muted }}>X-NC-Event</code>,{' '}
              <code style={{ color: colors.muted }}>Content-Type: application/json</code>
            </div>

            <div style={labelStyle}>Delivery behavior</div>
            <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: '14px', color: colors.muted, lineHeight: 1.8 }}>
              <li>Your endpoint must respond with <strong style={{ color: colors.cream }}>2xx</strong> within 10 seconds</li>
              <li>Failed deliveries retry 3 times with backoff: 1 min, 5 min, 25 min</li>
              <li>After <strong style={{ color: colors.cream }}>10 consecutive failures</strong>, the subscription is auto-disabled</li>
              <li>Re-enable with <code style={{ color: colors.cream }}>PATCH /api/v1/webhooks/:id</code> {'{ "status": "active" }'}</li>
            </ul>
          </div>
        </Section>

        {/* Signature Verification */}
        <Section title="Webhook Signature Verification" id="signature">
          <div style={styles.card}>
            <p style={{ margin: '0 0 16px 0', fontSize: '14px', color: colors.text, lineHeight: 1.7 }}>
              Every webhook includes an <code style={{ color: colors.cream, fontSize: '14px' }}>X-NC-Signature</code> header.
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
              {`curl -H "X-API-Key: nc_..." \\
  "${API_BASE}/api/v1/webhooks/{subscription_id}/deliveries?limit=10"

# Filter by status
curl -H "X-API-Key: nc_..." \\
  "${API_BASE}/api/v1/webhooks/{subscription_id}/deliveries?status=failed"`}
            </div>
            <div style={{ marginTop: '12px', fontSize: '14px', color: colors.muted }}>
              Delivery statuses:{' '}
              <code style={{ color: colors.success }}>delivered</code> ·{' '}
              <code style={{ color: colors.cream }}>pending</code> ·{' '}
              <code style={{ color: colors.cream }}>retrying</code> ·{' '}
              <code style={{ color: colors.error }}>failed</code>
            </div>
            <div style={{ marginTop: '4px', fontSize: '14px', color: colors.dim }}>
              Delivery logs are retained for 30 days.
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
              { name: 'organizer', type: 'object', desc: '{ name, phone }' },
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
                fontSize: '14px',
              }}>
                <span style={{ fontFamily: 'monospace', color: colors.cream }}>{f.name}</span>
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
              { code: '400', desc: 'Malformed request (missing fields, invalid types)' },
              { code: '401', desc: 'Invalid or missing API key (for key-required endpoints)' },
              { code: '404', desc: 'Resource not found' },
              { code: '429', desc: 'Rate limit exceeded' },
              { code: '500', desc: 'Server error' },
            ].map((e, i, arr) => (
              <div key={e.code} style={{
                display: 'flex',
                gap: '16px',
                padding: '8px 0',
                borderBottom: i < arr.length - 1 ? `1px solid ${colors.border}` : 'none',
                fontSize: '14px',
              }}>
                <span style={{ fontFamily: 'monospace', color: colors.error, minWidth: '40px' }}>{e.code}</span>
                <span style={{ color: colors.muted }}>{e.desc}</span>
              </div>
            ))}
            <div style={{ marginTop: '8px', fontSize: '14px', color: colors.dim }}>
              All errors return: {'{ "error": { "code": "...", "message": "..." } }'}
            </div>
          </div>
        </Section>

        {/* Terms */}
        <Section title="Terms & License" id="terms">
          <div style={styles.card}>
            <p style={{ margin: '0 0 12px 0', fontSize: '14px', color: colors.text, lineHeight: 1.7 }}>
              All event data is licensed under{' '}
              <strong style={{ color: colors.cream }}>Creative Commons Attribution 4.0 International (CC BY 4.0)</strong>.
              You are free to share, adapt, and build with this data.
            </p>
            <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: '14px', color: colors.muted, lineHeight: 1.8 }}>
              <li>Attribution: Credit <strong style={{ color: colors.cream }}>"Neighborhood Commons"</strong> or link to the API</li>
              <li>Rate limit: <strong style={{ color: colors.cream }}>1,000 requests/hour</strong> per API key or IP</li>
              <li>No surveillance, tracking, or profiling of event attendees</li>
              <li>Building products with this data is encouraged</li>
            </ul>
          </div>
        </Section>

        {/* Neighborhood API */}
        <Section title="Neighborhood API v0.2" id="spec">
          <div style={styles.card}>
            <p style={{ margin: '0 0 8px 0', fontSize: '14px', color: colors.muted, lineHeight: 1.6 }}>
              This API follows the{' '}
              <a href="https://github.com/The-Relational-Technology-Project/neighborhood-api"
                style={{ color: colors.muted, textDecoration: 'underline' }}
                target="_blank" rel="noopener noreferrer">
                Neighborhood API v0.2 spec
              </a>
              {' '}— an open format for sharing local events, assets, and plans across community tools.
            </p>
            <p style={{ margin: 0, fontSize: '14px', color: colors.dim, lineHeight: 1.6 }}>
              Steward: Neighborhood Commons · Region: Philadelphia · Resources: events · License: CC BY 4.0
            </p>
          </div>
        </Section>

        {/* Contact */}
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <p style={{ color: colors.muted, fontSize: '14px', marginBottom: '6px' }}>
            Building something with this data?
          </p>
          <p style={{ color: colors.dim, fontSize: '14px' }}>
            We'd love to hear about it — <span style={{ color: colors.muted }}>hello@joinfiber.app</span>
          </p>
        </div>
    </>
  );
}
