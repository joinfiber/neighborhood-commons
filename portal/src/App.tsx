import { useState, useEffect, useCallback } from 'react';
import { useAuth } from './hooks/useAuth';
import { useHashRoute } from './hooks/useHashRoute';
import { claimAccount, fetchAccount, fetchWhoami, updateProfile, type PortalAccount, type UserRole } from './lib/api';
import { colors, styles } from './lib/styles';
import { LoginScreen } from './screens/LoginScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { CreateEventScreen } from './screens/CreateEventScreen';
import { EditEventScreen } from './screens/EditEventScreen';
import { AdminDashboardScreen } from './screens/AdminDashboardScreen';
import { AdminAccountDetailScreen } from './screens/AdminAccountDetailScreen';
import { AdminCreateEventScreen } from './screens/AdminCreateEventScreen';
import { AdminEditEventScreen } from './screens/AdminEditEventScreen';
import { AdminAllEventsScreen } from './screens/AdminAllEventsScreen';
import { DevelopersScreen } from './screens/DevelopersScreen';
import { Toast } from './components/Toast';
import { PlaceAutocomplete } from './components/PlaceAutocomplete';
import type { PlaceResult } from './lib/api';

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

  // Developers page (accessible regardless of auth state)
  if (route.screen === 'developers') {
    return <DevelopersScreen onBack={() => navigate('#/')} />;
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
  // ADMIN ROUTES
  // =========================================================================
  if (role === 'admin') {
    const adminContent = (() => {
      if (route.screen === 'admin-account' && route.params.id) {
        return (
          <AdminAccountDetailScreen
            accountId={route.params.id}
            onBack={() => navigate('#/admin')}
            onCreateEvent={(acct) => navigate(`#/admin/events/new?account=${acct.id}`)}
            onEditEvent={(event, acct) => navigate(`#/admin/events/${event.id}/edit?account=${acct.id}`)}
          />
        );
      }

      if (route.screen === 'admin-create-event') {
        return (
          <AdminCreateEventScreen
            preSelectedAccountId={route.params.account}
            onBack={back}
            onCreated={(title, venue, date) => {
              back();
              setToast({ message: `${title} at ${venue} on ${date}`, type: 'success' });
            }}
          />
        );
      }

      if (route.screen === 'admin-events') {
        return (
          <AdminAllEventsScreen
            onBack={() => navigate('#/admin')}
            onViewAccount={(accountId) => navigate(`#/admin/accounts/${accountId}`)}
          />
        );
      }

      if (route.screen === 'admin-edit-event' && route.params.id && route.params.account) {
        return (
          <AdminEditEventScreen
            eventId={route.params.id}
            accountId={route.params.account}
            onBack={back}
            onUpdated={() => {
              back();
              setToast({ message: 'Event updated', type: 'success' });
            }}
            onDeleted={() => {
              navigate('#/admin');
              setToast({ message: 'Event deleted', type: 'success' });
            }}
          />
        );
      }

      // Default: admin dashboard
      return (
        <AdminDashboardScreen
          email={user?.email || ''}
          onSignOut={() => signOut()}
          onViewAccount={(acct) => navigate(`#/admin/accounts/${acct.id}`)}
          onViewAllEvents={() => navigate('#/admin/events')}
          onCreateEvent={() => navigate('#/admin/events/new')}
        />
      );
    })();

    return (
      <>
        {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
        {adminContent}
      </>
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
    if (route.screen === 'create-event') {
      return (
        <CreateEventScreen
          account={account}
          onBack={() => navigate('#/')}
          onCreated={(title, venue, date) => {
            navigate('#/');
            setToast({ message: `${title} at ${venue} on ${date}`, type: 'success' });
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
        />
      );
    }

    // Default: dashboard
    return (
      <DashboardScreen
        account={account}
        onCreateEvent={() => navigate('#/events/new')}
        onEditEvent={(event) => navigate(`#/events/${event.id}/edit`)}
        onSignOut={() => signOut()}
        onSignOutEverywhere={() => signOut('global')}
      />
    );
  })();

  return (
    <>
      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
      {businessContent}
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
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(null);
  const [website, setWebsite] = useState(account.website || '');
  const [phone, setPhone] = useState(account.phone || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);

    const params: Record<string, unknown> = {};
    if (venueName) params.default_venue_name = venueName;
    if (selectedPlace) {
      params.default_place_id = selectedPlace.place_id;
      params.default_address = selectedPlace.address;
      params.default_latitude = selectedPlace.location?.latitude ?? null;
      params.default_longitude = selectedPlace.location?.longitude ?? null;
    }
    if (website) params.website = website;
    if (phone) params.phone = phone;

    if (Object.keys(params).length === 0) {
      onSkip();
      return;
    }

    const res = await updateProfile(params as Parameters<typeof updateProfile>[0]);
    setSaving(false);

    if (res.data?.account) {
      onComplete(res.data.account);
    } else {
      setErr(res.error?.message || 'Failed to save');
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.ambientGlow} />
      <div style={{ ...styles.content, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
        <div className="fade-up" style={{ ...styles.card, maxWidth: '440px', width: '100%' }}>
          <h2 style={{ ...styles.pageTitle, textAlign: 'center', marginBottom: '4px' }}>
            Tell us about your business
          </h2>
          <p style={{ fontSize: '13px', color: colors.muted, textAlign: 'center', marginBottom: '24px' }}>
            This helps neighbors find you. You can always change this later.
          </p>

          {err && (
            <div style={{ background: '#2a1a18', color: colors.error, padding: '10px 14px', borderRadius: '8px', fontSize: '13px', marginBottom: '16px' }}>
              {err}
            </div>
          )}

          <form onSubmit={handleSave}>
            <div style={{ marginBottom: '14px' }}>
              <label style={styles.formLabel}>Business address</label>
              <PlaceAutocomplete
                value={venueName || ''}
                onChange={setVenueName}
                onSelect={(place) => {
                  setSelectedPlace(place);
                  setVenueName(place.name);
                }}
                placeholder="Search for your business..."
              />
              {selectedPlace?.address && (
                <div style={{ fontSize: '12px', color: colors.muted, marginTop: '4px' }}>
                  {selectedPlace.address}
                </div>
              )}
            </div>

            <div style={{ marginBottom: '14px' }}>
              <label style={styles.formLabel}>Website (optional)</label>
              <input
                type="url"
                placeholder="https://yourbusiness.com"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                style={styles.input}
              />
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={styles.formLabel}>Phone (optional)</label>
              <input
                type="tel"
                placeholder="(215) 555-0100"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                style={styles.input}
              />
            </div>

            <button type="submit" className="btn-primary" style={styles.buttonPrimary} disabled={saving}>
              {saving ? 'Saving...' : 'Save & Continue'}
            </button>
          </form>

          <div style={{ textAlign: 'center', marginTop: '12px' }}>
            <button type="button" className="btn-text" style={styles.buttonText} onClick={onSkip}>
              Skip for now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
