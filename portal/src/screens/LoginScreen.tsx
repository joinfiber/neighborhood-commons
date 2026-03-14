import { useState, useEffect } from 'react';
import { styles, loginColors, loginStyles } from '../lib/styles';
import { Turnstile } from '../components/Turnstile';

interface LoginScreenProps {
  onSignIn: (email: string, captchaToken?: string) => Promise<'otp_sent' | 'needs_signup' | 'error'>;
  onRegister: (email: string, businessName: string, captchaToken: string) => Promise<boolean>;
  onVerifyOtp: (email: string, token: string) => Promise<boolean>;
  onResetSignUp: () => void;
  loading: boolean;
  error: string | null;
  canSignUp: boolean;
  onShowDevelopers?: () => void;
}

type ScreenState = 'email' | 'signup' | 'otp';

export function LoginScreen({
  onSignIn, onRegister, onVerifyOtp, onResetSignUp,
  loading, error, canSignUp, onShowDevelopers,
}: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [otpCode, setOtpCode] = useState('');
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

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Require captcha before submission (matches admin app pattern)
    const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
    if (siteKey && !captchaToken) {
      setCaptchaError(true);
      return;
    }
    const result = await onSignIn(email, captchaToken || undefined);
    if (result === 'otp_sent') {
      setScreen('otp');
    } else if (result === 'error') {
      // Reset captcha on failure so user gets a fresh token
      setCaptchaToken(null);
    }
    // 'needs_signup' is handled by the canSignUp effect above
    // captchaToken is preserved in state for the register call
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!captchaToken) return;
    const success = await onRegister(email, businessName, captchaToken);
    if (success) setScreen('otp');
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onVerifyOtp(email, otpCode);
  };

  const handleBack = () => {
    setScreen('email');
    setBusinessName('');
    setOtpCode('');
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
        color: loginColors.amber,
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
        Your events.<br />
        Your neighbors.<br />
        Open data.
      </h1>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '32px' }}>
        {[
          'Post your happy hours, classes, open gym, specials — and neighbors nearby discover them',
          'Other event apps can pull your data in — for free',
          'Post once, reach everywhere',
        ].map((text, i) => (
          <div key={i} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
            <span style={{ color: loginColors.amber, fontSize: '16px', lineHeight: '22px', flexShrink: 0 }}>—</span>
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

        {screen === 'otp' ? (
          <div>
            <p style={{ color: loginColors.muted, fontSize: '13px', marginBottom: '16px', textAlign: 'center' }}>
              Enter the 8-digit code sent to{' '}
              <strong style={{ color: loginColors.cream }}>{email}</strong>
            </p>
            <form onSubmit={handleOtpSubmit}>
              <input
                type="text"
                placeholder="00000000"
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                style={{
                  ...loginStyles.input,
                  textAlign: 'center',
                  fontSize: '22px',
                  letterSpacing: '8px',
                  fontFamily: 'monospace',
                }}
                disabled={loading}
                maxLength={8}
                autoFocus
                required
              />
              <button
                type="submit"
                style={{ ...loginStyles.buttonPrimary, marginTop: '8px' }}
                disabled={loading || otpCode.length !== 8}
              >
                {loading ? 'Verifying...' : 'Sign In'}
              </button>
            </form>
            <div style={{ textAlign: 'center', marginTop: '12px' }}>
              <button type="button" style={loginStyles.buttonText} onClick={handleBack}>
                Use different email
              </button>
            </div>
          </div>
        ) : screen === 'signup' ? (
          <div>
            <h2 style={{ ...loginStyles.pageTitle, textAlign: 'center', marginBottom: '4px' }}>
              Let's get you set up
            </h2>
            <p style={{ fontSize: '13px', color: loginColors.muted, textAlign: 'center', marginBottom: '20px' }}>
              Create your free business account
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
                <label style={loginStyles.formLabel}>Business name</label>
                <input
                  type="text"
                  placeholder="e.g. Joe's Coffee"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  style={loginStyles.input}
                  disabled={loading}
                  maxLength={200}
                  autoFocus
                  required
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
                disabled={loading || !email.trim()}
              >
                {loading ? 'Checking...' : 'Continue'}
              </button>
              <p style={{ fontSize: '11px', color: loginColors.dim, textAlign: 'center', marginTop: '10px' }}>
                We'll send you a code — no password needed
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
