import { useState, useEffect } from 'react';
import { styles, loginColors, loginStyles } from '../lib/styles';
import { Turnstile } from '../components/Turnstile';

interface LoginScreenProps {
  onSignIn: (email: string) => Promise<'magic_link_sent' | 'needs_signup' | 'error'>;
  onRegister: (email: string, businessName: string, captchaToken: string) => Promise<boolean>;
  onResetSignUp: () => void;
  loading: boolean;
  error: string | null;
  canSignUp: boolean;
  magicLinkSent: boolean;
  onShowDevelopers?: () => void;
}

type ScreenState = 'email' | 'signup' | 'check-email';

export function LoginScreen({
  onSignIn, onRegister, onResetSignUp,
  loading, error, canSignUp, magicLinkSent, onShowDevelopers,
}: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [screen, setScreen] = useState<ScreenState>('email');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaError, setCaptchaError] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 900);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // When canSignUp changes from the hook, switch to signup form
  useEffect(() => {
    if (canSignUp && screen === 'email') setScreen('signup');
  }, [canSignUp, screen]);

  // When magic link is sent, show "check your email" screen
  useEffect(() => {
    if (magicLinkSent) setScreen('check-email');
  }, [magicLinkSent]);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSignIn(email);
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!captchaToken) return;
    await onRegister(email, businessName, captchaToken);
  };

  const handleBack = () => {
    setScreen('email');
    setBusinessName('');
    setCaptchaToken(null);
    setCaptchaError(false);
    onResetSignUp();
  };

  // ---- Marketing content ----

  const marketingContent = (
    <div style={{ maxWidth: '480px' }}>
      <div style={{
        fontSize: '13px',
        fontWeight: 300,
        letterSpacing: '0.12em',
        textTransform: 'uppercase' as const,
        color: loginColors.accent,
        marginBottom: '20px',
      }}>
        neighborhood commons
      </div>

      <h1 style={{
        fontSize: isMobile ? '26px' : '32px',
        fontWeight: 300,
        lineHeight: 1.25,
        color: loginColors.cream,
        margin: '0 0 28px 0',
        letterSpacing: '-0.01em',
      }}>
        Share your data.<br />
        Enrich the commons.<br />
        Open infrastructure.
      </h1>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '32px' }}>
        {[
          'Upload a CSV of events, food pantries, community resources — anything your neighborhood should know about',
          'Your data flows to every app connected to the Commons',
          'Contribute once, reach everywhere',
        ].map((text, i) => (
          <div key={i} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
            <span style={{ color: loginColors.accent, fontSize: '16px', lineHeight: '22px', flexShrink: 0 }}>—</span>
            <span style={{ color: loginColors.text, fontSize: '15px', lineHeight: '22px' }}>{text}</span>
          </div>
        ))}
      </div>

      <p style={{
        color: loginColors.muted,
        fontSize: '14px',
        lineHeight: 1.6,
        marginBottom: '12px',
      }}>
        Because the data is open, post once and every app can use it. No more copy-pasting your schedule into five different platforms.
      </p>

      <p style={{
        color: loginColors.dim,
        fontSize: '13px',
        lineHeight: 1.5,
        marginBottom: '32px',
      }}>
        Free to post. Free forever. We review every business to keep the Commons useful for the neighborhood.
      </p>

      {onShowDevelopers && (
        <button
          type="button"
          style={{ ...loginStyles.buttonText, padding: 0, fontSize: '13px', color: loginColors.muted }}
          onClick={onShowDevelopers}
        >
          Developers: grab the data →
        </button>
      )}
    </div>
  );

  // ---- Login / signup card ----

  const loginCard = (
    <div style={{ width: '100%', maxWidth: '380px' }}>
      <div className="fade-up" style={loginStyles.card}>
        {error && (
          <div style={{
            background: '#2a1a18',
            color: loginColors.error,
            padding: '10px 14px',
            borderRadius: '8px',
            fontSize: '13px',
            marginBottom: '16px',
          }}>
            {error}
          </div>
        )}
        {captchaError && !error && (
          <div style={{
            background: '#2a1a18',
            color: loginColors.error,
            padding: '10px 14px',
            borderRadius: '8px',
            fontSize: '13px',
            marginBottom: '16px',
          }}>
            Please wait for security verification to complete
          </div>
        )}

        {screen === 'check-email' ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '32px', marginBottom: '16px' }}>&#9993;</div>
            <p style={{ color: loginColors.cream, fontSize: '16px', fontWeight: 500, marginBottom: '8px' }}>
              Check your email
            </p>
            <p style={{ color: loginColors.muted, fontSize: '13px', marginBottom: '24px', lineHeight: 1.5 }}>
              We sent a sign-in link to{' '}
              <strong style={{ color: loginColors.cream }}>{email}</strong>
            </p>
            <p style={{ color: loginColors.dim, fontSize: '12px', lineHeight: 1.5, marginBottom: '20px' }}>
              Click the link in your email to sign in. You can close this tab.
            </p>
            <button type="button" style={loginStyles.buttonText} onClick={handleBack}>
              Use different email
            </button>
          </div>
        ) : screen === 'signup' ? (
          <div>
            <h2 style={{ ...loginStyles.pageTitle, textAlign: 'center', marginBottom: '4px' }}>
              Let's get you set up
            </h2>
            <p style={{ fontSize: '13px', color: loginColors.muted, textAlign: 'center', marginBottom: '20px' }}>
              Create your free contributor account
            </p>
            <form onSubmit={handleRegisterSubmit}>
              <div style={{ marginBottom: '12px' }}>
                <label style={loginStyles.formLabel}>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{ ...loginStyles.input, color: loginColors.muted }}
                  disabled={loading}
                  required
                />
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label style={loginStyles.formLabel}>Organization or project name</label>
                <input
                  type="text"
                  placeholder="e.g. Philly Food Map"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  style={loginStyles.input}
                  disabled={loading}
                  maxLength={200}
                  autoFocus
                  required
                />
              </div>
              <div style={{ margin: '12px 0', display: 'flex', justifyContent: 'center' }}>
                <Turnstile
                  onVerify={(token) => { setCaptchaToken(token); setCaptchaError(false); }}
                  onError={() => { setCaptchaError(true); setCaptchaToken(null); }}
                  onExpire={() => setCaptchaToken(null)}
                />
              </div>
              <button
                type="submit"
                style={loginStyles.buttonPrimary}
                disabled={loading || !captchaToken || !businessName.trim()}
              >
                {loading ? 'Creating account...' : 'Create Account'}
              </button>
              <p style={{ fontSize: '11px', color: loginColors.dim, textAlign: 'center', marginTop: '10px', lineHeight: 1.5 }}>
                By creating an account, you agree to our{' '}
                <a href="#/terms" style={{ color: loginColors.muted, textDecoration: 'underline' }}>Terms of Use</a>
              </p>
            </form>
            <div style={{ textAlign: 'center', marginTop: '12px' }}>
              <button type="button" style={loginStyles.buttonText} onClick={handleBack}>
                ← Back
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: '13px', color: loginColors.muted, textAlign: 'center', marginBottom: '20px' }}>
              Sign in or get started
            </p>
            <form onSubmit={handleEmailSubmit}>
              <input
                type="email"
                placeholder="you@yourbusiness.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={loginStyles.input}
                disabled={loading}
                autoFocus
                required
              />
              <button
                type="submit"
                style={{ ...loginStyles.buttonPrimary, marginTop: '12px' }}
                disabled={loading || !email.trim()}
              >
                {loading ? 'Checking...' : 'Continue'}
              </button>
              <p style={{ fontSize: '11px', color: loginColors.dim, textAlign: 'center', marginTop: '10px' }}>
                We'll send you a link — no password needed
              </p>
            </form>
          </div>
        )}
      </div>
    </div>
  );

  // ---- Layout ----

  if (isMobile) {
    return (
      <div className="login-page" style={{ ...loginStyles.page, padding: '24px 20px' }}>
        <div style={styles.ambientGlow} />
        <div style={{ width: '100%', maxWidth: '420px', position: 'relative' as const, zIndex: 1 }}>
          {loginCard}
          <div style={{ marginTop: '48px' }}>
            {marketingContent}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page" style={styles.splitLayout}>
      <div style={styles.ambientGlow} />
      <div style={styles.marketingColumn}>
        {marketingContent}
      </div>
      <div style={styles.loginColumn}>
        {loginCard}
      </div>
    </div>
  );
}
