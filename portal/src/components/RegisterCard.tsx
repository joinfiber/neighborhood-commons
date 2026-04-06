import { useState } from 'react';
import { styles, colors } from '../lib/styles';

const API_URL = import.meta.env.VITE_API_URL || '';

type RegStep = 'idle' | 'email' | 'verify' | 'done';

interface RegisterCardProps {
  /** Label shown on the initial button. Defaults to "Get an API Key" */
  buttonLabel?: string;
  /** Description shown in idle state */
  description?: string;
}

export function RegisterCard({
  buttonLabel = 'Get an API Key',
  description = 'Get a free API key for a dedicated rate limit bucket and webhook access. No approval required — verify your email and you\'re in.',
}: RegisterCardProps) {
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
          {description}
        </p>
        <button type="button" onClick={() => setStep('email')} style={{ ...styles.buttonPrimary, fontSize: '14px', padding: '10px 20px', cursor: 'pointer', borderRadius: '8px' }}>
          {buttonLabel}
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
          color: colors.heading,
          wordBreak: 'break-all',
          marginBottom: '12px',
        }}>
          {apiKey}
        </div>
        <button type="button" onClick={handleCopy} style={{ ...styles.buttonPrimary, fontSize: '14px', padding: '8px 16px', cursor: 'pointer', borderRadius: '8px' }}>
          {copied ? 'Copied!' : 'Copy to clipboard'}
        </button>
        <div style={{ marginTop: '12px', fontSize: '14px', color: colors.heading }}>
          Save this key now — it will not be shown again.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      {error && (
        <div style={{ background: colors.errorBg, color: colors.error, padding: '8px 12px', borderRadius: '6px', fontSize: '14px', marginBottom: '12px' }}>
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
          <button type="button" onClick={() => { setStep('idle'); setError(''); }} style={{ background: 'none', border: 'none', color: colors.dim, fontSize: '14px', cursor: 'pointer', fontFamily: 'inherit' }}>
            Cancel
          </button>
        </form>
      )}

      {step === 'verify' && (
        <form onSubmit={(e) => { e.preventDefault(); void handleVerify(); }} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <p style={{ margin: 0, fontSize: '14px', color: colors.muted }}>
            We sent a code to <strong style={{ color: colors.heading }}>{email}</strong>
          </p>
          <div>
            <label style={{ fontSize: '14px', color: colors.muted, display: 'block', marginBottom: '4px' }}>Verification code</label>
            <input type="text" value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="12345678" required maxLength={8} style={{ ...inputStyle, letterSpacing: '0.15em', textAlign: 'center', fontSize: '18px' }} />
          </div>
          <button type="submit" disabled={loading} style={submitStyle}>
            {loading ? 'Verifying...' : 'Verify & get key'}
          </button>
          <button type="button" onClick={() => { setStep('email'); setOtp(''); setError(''); }} style={{ background: 'none', border: 'none', color: colors.dim, fontSize: '14px', cursor: 'pointer', fontFamily: 'inherit' }}>
            Back
          </button>
        </form>
      )}
    </div>
  );
}
