import { useState, useEffect, useCallback } from 'react';
import { useAuth } from './hooks/useAuth';
import { useHashRoute } from './hooks/useHashRoute';
import { claimAccount, fetchAccount, fetchWhoami, type PortalAccount, type UserRole } from './lib/api';
import { colors, styles } from './lib/styles';
import { LoginScreen } from './screens/LoginScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { CreateEventScreen } from './screens/CreateEventScreen';
import { EditEventScreen } from './screens/EditEventScreen';
import { ContributeScreen } from './screens/ContributeScreen';
import { ContributionsScreen } from './screens/ContributionsScreen';
import { DevelopersScreen } from './screens/DevelopersScreen';
import { ProfileScreen } from './screens/ProfileScreen';
import { TermsScreen } from './screens/TermsScreen';
import { Toast } from './components/Toast';
import { WorkspaceShell } from './components/WorkspaceShell';

function contentWidthForRoute(screen: string): 'normal' | 'wide' | 'full' {
  const full = ['create-event', 'edit-event', 'profile'];
  if (full.includes(screen)) return 'full';
  const wide = ['dashboard', 'contributions', 'developers'];
  return wide.includes(screen) ? 'wide' : 'normal';
}

export default function App() {
  const { route, navigate, back } = useHashRoute();
  const { isAuthenticated, initializing, loading, error, signIn, register, signOut, resetSignUp, canSignUp, magicLinkSent, user } = useAuth();

  // Role detection (confirmed after auth via /whoami)
  const [role, setRole] = useState<UserRole | null>(null);
  const [roleLoading, setRoleLoading] = useState(false);

  // Business state
  const [account, setAccount] = useState<PortalAccount | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  // UI state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Detect role after authentication via /whoami
  const detectRole = useCallback(async () => {
    setRoleLoading(true);
    const res = await fetchWhoami();
    if (res.data) {
      setRole(res.data.role);
      if (res.data.role === 'business' && res.data.account) {
        setAccount(res.data.account);
        // No more venue onboarding — contributors don't need address setup
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
      setAccount(claimRes.data.account);
      setClaiming(false);
      return;
    }

    const fetchRes = await fetchAccount();
    if (fetchRes.data) {
      setAccount(fetchRes.data.account);
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

  // Not authenticated → show login screen (regardless of which route they wanted)
  if (!isAuthenticated) {
    return (
      <LoginScreen
        onSignIn={signIn}
        onRegister={register}
        onResetSignUp={resetSignUp}
        loading={loading}
        error={error}
        canSignUp={canSignUp}
        magicLinkSent={magicLinkSent}
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
              Contact us at hi@neighborhood-commons.org to get set up.
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
  // CONTRIBUTOR ROUTES
  // =========================================================================
  const businessContent = (() => {
    if (route.screen === 'upload') {
      return (
        <ContributeScreen
          account={account}
          onDone={(count) => {
            navigate('#/');
            setToast({ message: `Contributed ${count} event${count !== 1 ? 's' : ''}`, type: 'success' });
          }}
        />
      );
    }

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

    // Dashboard (accessible via #/events but not primary nav)
    if (route.screen === 'dashboard' || route.screen === 'events') {
      return (
        <DashboardScreen
          account={account}
          onEditEvent={(event) => navigate(`#/events/${event.id}/edit`)}
          onShareEvent={(event) => navigate(`#/events/${event.id}/share`)}
        />
      );
    }

    // Default: contributions
    return (
      <ContributionsScreen
        account={account}
        onNavigate={(screen) => navigate(`#/${screen}`)}
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

