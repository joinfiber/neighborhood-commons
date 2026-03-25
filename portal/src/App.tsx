import { useState, useEffect, useCallback } from 'react';
import { useAuth } from './hooks/useAuth';
import { useHashRoute } from './hooks/useHashRoute';
import { claimAccount, fetchAccount, fetchWhoami, updateProfile, type PortalAccount, type UserRole } from './lib/api';
import { colors, styles, spacing, radii } from './lib/styles';
import { LoginScreen } from './screens/LoginScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { CreateEventScreen } from './screens/CreateEventScreen';
import { EditEventScreen } from './screens/EditEventScreen';
import { ImportEventsScreen } from './screens/ImportEventsScreen';
import { DevelopersScreen } from './screens/DevelopersScreen';
import { ProfileScreen } from './screens/ProfileScreen';
import { TermsScreen } from './screens/TermsScreen';
import { Toast } from './components/Toast';
import { WorkspaceShell } from './components/WorkspaceShell';

function contentWidthForRoute(screen: string): 'normal' | 'wide' | 'full' {
  const full = ['create-event', 'edit-event', 'profile'];
  if (full.includes(screen)) return 'full';
  const wide = ['dashboard', 'developers'];
  return wide.includes(screen) ? 'wide' : 'normal';
}

export default function App() {
  const { route, navigate, back } = useHashRoute();
  const { isAuthenticated, initializing, loading, error, signIn, register, verifyOtp, signOut, resetSignUp, canSignUp, user } = useAuth();

  // Role detection (confirmed after auth via /whoami)
  const [role, setRole] = useState<UserRole | null>(null);
  const [roleLoading, setRoleLoading] = useState(false);

  // Business state
  const [account, setAccount] = useState<PortalAccount | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  // UI state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Detect role after authentication via /whoami
  const detectRole = useCallback(async () => {
    setRoleLoading(true);
    const res = await fetchWhoami();
    if (res.data) {
      setRole(res.data.role);
      if (res.data.role === 'business' && res.data.account) {
        setAccount(res.data.account);
        if (res.data.account.status === 'pending' && !res.data.account.default_address) {
          setShowOnboarding(true);
        }
      }
    } else {
      setRole('business');
    }
    setRoleLoading(false);
  }, []);

  // Business account claim (only if whoami returned business but no account)
  const loadAccount = useCallback(async () => {
    setClaiming(true);
    setClaimError(null);

    const claimRes = await claimAccount();
    if (claimRes.data) {
      const acct = claimRes.data.account;
      setAccount(acct);
      if (acct.status === 'pending' && !acct.default_address) {
        setShowOnboarding(true);
      }
      setClaiming(false);
      return;
    }

    const fetchRes = await fetchAccount();
    if (fetchRes.data) {
      const acct = fetchRes.data.account;
      setAccount(acct);
      if (acct.status === 'pending' && !acct.default_address) {
        setShowOnboarding(true);
      }
      setClaiming(false);
      return;
    }

    setClaimError(claimRes.error?.message || 'No portal account found for this email');
    setClaiming(false);
  }, []);

  useEffect(() => {
    if (isAuthenticated && !role && !roleLoading) {
      detectRole();
    }
    if (isAuthenticated && role === 'business' && !account && !claiming && !claimError) {
      loadAccount();
    }
    if (!isAuthenticated) {
      setRole(null);
      setAccount(null);
      setClaimError(null);
      setShowOnboarding(false);
    }
  }, [isAuthenticated, role, roleLoading, account, claiming, claimError, detectRole, loadAccount]);

  // =========================================================================
  // LOADING / INITIALIZING
  // =========================================================================

  if (initializing) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: colors.dim, fontSize: '14px' }}>Loading...</div>
      </div>
    );
  }

  // Public pages (accessible regardless of auth state)
  if (route.screen === 'terms') {
    return <TermsScreen onBack={() => navigate('#/')} />;
  }

  if (route.screen === 'developers' && !isAuthenticated) {
    return <DevelopersScreen />;
  }

  // Login
  if (!isAuthenticated) {
    return (
      <LoginScreen
        onSignIn={signIn}
        onRegister={register}
        onVerifyOtp={verifyOtp}
        onResetSignUp={resetSignUp}
        loading={loading}
        error={error}
        canSignUp={canSignUp}
        onShowDevelopers={() => navigate('#/developers')}
      />
    );
  }

  // Role loading
  if (roleLoading || !role) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: colors.dim, fontSize: '14px' }}>Loading...</div>
      </div>
    );
  }

  // =========================================================================
  // ADMIN — redirect to external admin app
  // =========================================================================

  if (role === 'admin') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
        <div style={{
          background: colors.card,
          border: `1px solid ${colors.border}`,
          borderRadius: '14px',
          padding: '32px',
          maxWidth: '400px',
          width: '100%',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '15px', color: colors.cream, marginBottom: '8px' }}>
            Admin tools have moved
          </div>
          <div style={{ fontSize: '13px', color: colors.muted, marginBottom: '20px', lineHeight: 1.5 }}>
            Use the Fiber Admin app to manage the commons.
          </div>
          <button
            className="btn-secondary"
            style={{ ...styles.buttonSecondary, width: 'auto', padding: '10px 24px' }}
            onClick={() => signOut()}
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  // =========================================================================
  // BUSINESS FLOW — account claim / error
  // =========================================================================

  if (!account) {
    if (claimError) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div style={{
            background: colors.card,
            border: `1px solid ${colors.border}`,
            borderRadius: '14px',
            padding: '32px',
            maxWidth: '380px',
            width: '100%',
            textAlign: 'center',
          }}>
            <div style={{ fontSize: '15px', color: colors.cream, marginBottom: '8px' }}>
              No portal account found
            </div>
            <div style={{ fontSize: '13px', color: colors.muted, marginBottom: '20px' }}>
              <strong>{user?.email}</strong> doesn't have a portal account yet.
              Contact us at hello@joinfiber.app to get set up.
            </div>
            <button
              className="btn-secondary"
              style={{ ...styles.buttonSecondary, width: 'auto', padding: '10px 24px' }}
              onClick={() => signOut()}
            >
              Sign Out
            </button>
          </div>
        </div>
      );
    }

    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: colors.dim, fontSize: '14px' }}>Setting up your account...</div>
      </div>
    );
  }

  // =========================================================================
  // ONBOARDING
  // =========================================================================
  if (showOnboarding) {
    return (
      <OnboardingScreen
        account={account}
        onComplete={(updated) => { setAccount(updated); setShowOnboarding(false); }}
        onSkip={() => setShowOnboarding(false)}
      />
    );
  }

  // =========================================================================
  // BUSINESS ROUTES
  // =========================================================================
  const businessContent = (() => {
    if (route.screen === 'profile') {
      return (
        <ProfileScreen
          account={account}
          onAccountUpdated={(updated) => setAccount(updated)}
        />
      );
    }

    if (route.screen === 'developers') {
      return <DevelopersScreen />;
    }

    if (route.screen === 'import-events') {
      return (
        <ImportEventsScreen
          account={account}
          onDone={(count) => {
            navigate('#/');
            setToast({ message: `Imported ${count} event${count !== 1 ? 's' : ''}`, type: 'success' });
          }}
        />
      );
    }

    if (route.screen === 'create-event') {
      return (
        <CreateEventScreen
          account={account}
          onBack={() => navigate('#/')}
          onCreated={() => {
            navigate('#/');
            setToast({ message: 'Event published', type: 'success' });
          }}
        />
      );
    }

    if (route.screen === 'edit-event' && route.params.id) {
      return (
        <EditEventScreen
          id={route.params.id}
          accountWheelchairAccessible={account?.wheelchair_accessible ?? null}
          onBack={back}
          onUpdated={() => {
            navigate('#/');
            setToast({ message: 'Event updated', type: 'success' });
          }}
          onDeleted={() => {
            navigate('#/');
            setToast({ message: 'Event deleted', type: 'success' });
          }}
          onShare={() => navigate(`#/events/${route.params.id}/share`)}
        />
      );
    }

    // Default: dashboard
    return (
      <DashboardScreen
        account={account}
        onEditEvent={(event) => navigate(`#/events/${event.id}/edit`)}
        onShareEvent={(event) => navigate(`#/events/${event.id}/share`)}
      />
    );
  })();

  return (
    <>
      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
      <WorkspaceShell
        activeScreen={route.screen}
        contentWidth={contentWidthForRoute(route.screen)}
        account={account}
        onNavigate={navigate}
        onSignOut={() => signOut()}
        onSignOutEverywhere={() => signOut('global')}
      >
        {businessContent}
      </WorkspaceShell>
    </>
  );
}

// =============================================================================
// ONBOARDING SCREEN (inline — shown once after signup)
// =============================================================================

function OnboardingScreen({ account, onComplete, onSkip }: {
  account: PortalAccount;
  onComplete: (updated: PortalAccount) => void;
  onSkip: () => void;
}) {
  const [venueName, setVenueName] = useState(account.default_venue_name || account.business_name);
  const [address, setAddress] = useState(account.default_address || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);

    const params: Record<string, unknown> = {};
    if (venueName) params.default_venue_name = venueName;
    if (address) params.default_address = address;

    if (Object.keys(params).length === 0) { onSkip(); return; }

    const res = await updateProfile(params as Parameters<typeof updateProfile>[0]);
    setSaving(false);
    if (res.data?.account) onComplete(res.data.account);
    else setErr(res.error?.message || 'Failed to save');
  };

  return (
    <div style={styles.page}>
      <div style={{ ...styles.content, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
        <div className="motion-fade-in" style={{ ...styles.card, maxWidth: '420px', width: '100%' }}>
          <h2 style={{ ...styles.pageTitle, textAlign: 'center', marginBottom: '6px' }}>
            Where is your business?
          </h2>
          <p style={{ fontSize: '13px', color: colors.muted, textAlign: 'center', marginBottom: spacing.lg, lineHeight: 1.5 }}>
            This auto-fills the venue on your events. You can change it anytime in your profile.
          </p>

          {err && (
            <div style={{ background: colors.errorBg, color: colors.error, padding: '10px 14px', borderRadius: radii.md, fontSize: '14px', marginBottom: spacing.md }}>
              {err}
            </div>
          )}

          <form onSubmit={handleSave}>
            <div style={{ marginBottom: spacing.md }}>
              <input type="text" value={venueName || ''} onChange={(e) => setVenueName(e.target.value)}
                placeholder="Your venue name" style={styles.input} />
            </div>
            <div style={{ marginBottom: spacing.lg }}>
              <input type="text" value={address} onChange={(e) => setAddress(e.target.value)}
                placeholder="Address" style={styles.input} />
            </div>

            <button type="submit" className="btn-primary" style={styles.buttonPrimary} disabled={saving}>
              {saving ? 'Saving...' : 'Continue'}
            </button>
          </form>

          <div style={{ textAlign: 'center', marginTop: '10px' }}>
            <button type="button" className="btn-text" style={styles.buttonText} onClick={onSkip}>
              Skip — I'll add it later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
