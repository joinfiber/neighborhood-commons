import { useState, useEffect, useCallback } from 'react';
import { useAuth } from './hooks/useAuth';
import { useHashRoute } from './hooks/useHashRoute';
import { claimAccount, fetchAccount, fetchWhoami, updateProfile, setImpersonation, type PortalAccount, type UserRole } from './lib/api';
import { colors, styles, spacing, radii } from './lib/styles';
import { LoginScreen } from './screens/LoginScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { CreateEventScreen } from './screens/CreateEventScreen';
import { EditEventScreen } from './screens/EditEventScreen';
import { ImportEventsScreen } from './screens/ImportEventsScreen';
import { AdminDashboardScreen } from './screens/AdminDashboardScreen';
import { AdminAccountDetailScreen } from './screens/AdminAccountDetailScreen';
import { AdminCreateEventScreen } from './screens/AdminCreateEventScreen';
import { AdminEditEventScreen } from './screens/AdminEditEventScreen';
import { AdminAllEventsScreen } from './screens/AdminAllEventsScreen';
import { AdminNewsletterSourcesScreen } from './screens/AdminNewsletterSourcesScreen';
import { AdminNewsletterEmailsScreen } from './screens/AdminNewsletterEmailsScreen';
import { AdminEventReviewScreen } from './screens/AdminEventReviewScreen';
import { AdminFeedSourcesScreen } from './screens/AdminFeedSourcesScreen';
import { AdminSourcesScreen } from './screens/AdminSourcesScreen';
import { AdminAuditScreen } from './screens/AdminAuditScreen';
import { DevelopersScreen } from './screens/DevelopersScreen';
import { ProfileScreen } from './screens/ProfileScreen';
import { TermsScreen } from './screens/TermsScreen';
import { ShareStudioScreen } from './screens/ShareStudioScreen';
import { CreativeScreen } from './screens/CreativeScreen';
import { Toast } from './components/Toast';
import { WorkspaceShell } from './components/WorkspaceShell';
import { PlaceAutocomplete } from './components/PlaceAutocomplete';
import type { PlaceResult } from './lib/api';

function contentWidthForRoute(screen: string): 'normal' | 'wide' | 'full' {
  const full = ['share-event', 'create-event', 'edit-event', 'admin-create-event', 'admin-edit-event', 'profile'];
  if (full.includes(screen)) return 'full';
  const wide = ['dashboard', 'creative', 'developers', 'admin-home', 'admin-events', 'admin-account', 'admin-accounts', 'admin-sources', 'admin-audit', 'admin-newsletters', 'admin-newsletter-emails', 'admin-newsletter-email', 'admin-newsletter-review', 'admin-feeds'];
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

  // Admin impersonation state
  const [actAsAccount, setActAsAccount] = useState<PortalAccount | null>(null);

  // Detect role after authentication via /whoami
  const detectRole = useCallback(async () => {
    setRoleLoading(true);
    const res = await fetchWhoami();
    if (res.data) {
      // Admin impersonation restored from sessionStorage: /whoami returns
      // role='business' + impersonating=true. Set the real role to admin
      // and populate the impersonation state instead of the business state.
      if (res.data.impersonating && res.data.account) {
        setRole('admin');
        setActAsAccount(res.data.account);
      } else {
        setRole(res.data.role);
        if (res.data.role === 'business' && res.data.account) {
          setAccount(res.data.account);
          if (res.data.account.status === 'pending' && !res.data.account.default_address) {
            setShowOnboarding(true);
          }
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
      setActAsAccount(null);
      setImpersonation(null);
    }
  }, [isAuthenticated, role, roleLoading, account, claiming, claimError, detectRole, loadAccount]);

  // Note: impersonation restore on page refresh is handled by detectRole() —
  // /whoami returns impersonating:true when X-Act-As-Account header is present,
  // so detectRole sets role='admin' + actAsAccount in one pass.

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
  // ADMIN ROUTES
  // =========================================================================

  function startActAs(acct: PortalAccount) {
    setImpersonation(acct.id);
    setActAsAccount(acct);
    navigate('#/');
  }

  function stopActAs() {
    setImpersonation(null);
    setActAsAccount(null);
    navigate('#/admin');
  }

  if (role === 'admin') {
    // Admin impersonation mode: show regular business screens as the target account
    if (actAsAccount) {
      const businessContent = (() => {
        if (route.screen === 'profile') {
          return (
            <ProfileScreen
              account={actAsAccount}
              onAccountUpdated={(updated) => setActAsAccount(updated)}
            />
          );
        }

        if (route.screen === 'creative') {
          return (
            <CreativeScreen
              onShareEvent={(event) => navigate(`#/events/${event.id}/share`)}
            />
          );
        }

        if (route.screen === 'share-event' && route.params.id) {
          return (
            <ShareStudioScreen
              eventId={route.params.id}
              onDone={() => navigate('#/creative')}
            />
          );
        }

        if (route.screen === 'developers') {
          return <DevelopersScreen />;
        }

        if (route.screen === 'import-events') {
          return (
            <ImportEventsScreen
              account={actAsAccount}
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
              account={actAsAccount}
              onBack={() => navigate('#/')}
              onCreated={(eventId) => {
                navigate(`#/events/${eventId}/share`);
              }}
            />
          );
        }

        if (route.screen === 'edit-event' && route.params.id) {
          return (
            <EditEventScreen
              id={route.params.id}
              accountWheelchairAccessible={actAsAccount?.wheelchair_accessible ?? null}
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

        return (
          <DashboardScreen
            account={actAsAccount}
            onEditEvent={(event) => navigate(`#/events/${event.id}/edit`)}
            onShareEvent={(event) => navigate(`#/events/${event.id}/share`)}
          />
        );
      })();

      return (
        <>
          <div style={{
            background: '#2563eb',
            color: '#fff',
            padding: '6px 16px',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            position: 'sticky',
            top: 0,
            zIndex: 9999,
          }}>
            <span>Acting as <strong>{actAsAccount.business_name}</strong></span>
            <button
              onClick={stopActAs}
              style={{
                background: 'rgba(255,255,255,0.2)',
                border: 'none',
                color: '#fff',
                padding: '4px 12px',
                borderRadius: '4px',
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              Exit
            </button>
          </div>
          {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
          <WorkspaceShell
            activeScreen={route.screen}
            contentWidth={contentWidthForRoute(route.screen)}
            role="business"
            account={actAsAccount}
            onNavigate={navigate}
            onSignOut={() => signOut()}
            onSignOutEverywhere={() => signOut('global')}
          >
            {businessContent}
          </WorkspaceShell>
        </>
      );
    }

    const adminContent = (() => {
      if (route.screen === 'admin-account' && route.params.id) {
        return (
          <AdminAccountDetailScreen
            accountId={route.params.id}
            onBack={() => navigate('#/admin')}
            onCreateEvent={(acct) => navigate(`#/admin/events/new?account=${acct.id}`)}
            onEditEvent={(event, acct) => navigate(`#/admin/events/${event.id}/edit?account=${acct.id}`)}
            onActAs={startActAs}
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

      if (route.screen === 'admin-accounts') {
        return (
          <AdminDashboardScreen
            email={user?.email || ''}
            onViewAccount={(acct) => navigate(`#/admin/accounts/${acct.id}`)}
            onViewAllEvents={() => navigate('#/admin/events')}
            onCreateEvent={() => navigate('#/admin/events/new')}
          />
        );
      }

      if (route.screen === 'admin-sources') {
        return <AdminSourcesScreen onNavigate={navigate} />;
      }

      if (route.screen === 'admin-audit') {
        return <AdminAuditScreen />;
      }

      // Legacy routes — keep working for bookmarks/links
      if (route.screen === 'admin-newsletters') {
        return <AdminNewsletterSourcesScreen onNavigate={navigate} />;
      }

      if (route.screen === 'admin-newsletter-emails' || route.screen === 'admin-newsletter-email') {
        return (
          <AdminNewsletterEmailsScreen
            emailId={route.params.id}
            onNavigate={navigate}
            onBack={back}
          />
        );
      }

      if (route.screen === 'admin-feeds') {
        return <AdminFeedSourcesScreen />;
      }

      // Default: review screen (admin home)
      return <AdminEventReviewScreen onNavigate={navigate} />;
    })();

    return (
      <>
        {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
        <WorkspaceShell
          activeScreen={route.screen}
          contentWidth={contentWidthForRoute(route.screen)}
          role="admin"
          onNavigate={navigate}
          onSignOut={() => signOut()}
          onSignOutEverywhere={() => signOut('global')}
        >
          {adminContent}
        </WorkspaceShell>
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
    if (route.screen === 'profile') {
      return (
        <ProfileScreen
          account={account}
          onAccountUpdated={(updated) => setAccount(updated)}
        />
      );
    }

    if (route.screen === 'creative') {
      return (
        <CreativeScreen
          onShareEvent={(event) => navigate(`#/events/${event.id}/share`)}
        />
      );
    }

    if (route.screen === 'share-event' && route.params.id) {
      return (
        <ShareStudioScreen
          eventId={route.params.id}
          onDone={() => navigate('#/creative')}
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
          onCreated={(eventId) => {
            navigate(`#/events/${eventId}/share`);
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
        role="business"
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
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(null);
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
            <div style={{ marginBottom: spacing.lg }}>
              <PlaceAutocomplete
                value={venueName || ''}
                onChange={setVenueName}
                onSelect={(place) => { setSelectedPlace(place); setVenueName(place.name); }}
                placeholder="Search for your business..."
              />
              {selectedPlace?.address && (
                <div style={{ fontSize: '12px', color: colors.muted, marginTop: '6px' }}>
                  {selectedPlace.address}
                </div>
              )}
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
