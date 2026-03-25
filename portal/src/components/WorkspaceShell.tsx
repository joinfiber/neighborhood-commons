import { colors, styles, radii } from '../lib/styles';
import { useBreakpoint } from '../hooks/useBreakpoint';
import type { PortalAccount } from '../lib/api';

// ---------------------------------------------------------------------------
// Nav configuration
// ---------------------------------------------------------------------------

interface NavItem {
  id: string;
  label: string;
  hash: string;
  screens: string[];
  icon?: React.ReactNode; // for mobile tab bar
}

const ICON_SIZE = 20;

const BUSINESS_NAV: NavItem[] = [
  { id: 'dashboard', label: 'Events', hash: '#/', screens: ['dashboard', 'edit-event', 'create-event'],
    icon: <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="14" height="13" rx="2" /><path d="M6 2v3M14 2v3M3 9h14" /></svg> },
  { id: 'new', label: 'New', hash: '#/events/new', screens: [],
    icon: <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M10 4v12M4 10h12" /></svg> },
  { id: 'developers', label: 'API', hash: '#/developers', screens: ['developers'],
    icon: <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 5L2 10l4 5M14 5l4 5-4 5" /></svg> },
  { id: 'profile', label: 'Profile', hash: '#/profile', screens: ['profile'],
    icon: <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="7" r="3" /><path d="M4 18c0-3.31 2.69-6 6-6s6 2.69 6 6" /></svg> },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WorkspaceShellProps {
  children: React.ReactNode;
  activeScreen: string;
  contentWidth?: 'normal' | 'wide' | 'full';
  account?: PortalAccount | null;
  onNavigate: (hash: string) => void;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkspaceShell({
  children,
  activeScreen,
  contentWidth = 'normal',
  account,
  onNavigate,
  onSignOut,
  onSignOutEverywhere: _onSignOutEverywhere,
}: WorkspaceShellProps) {
  void _onSignOutEverywhere; // retained for future use
  const { isDesktop } = useBreakpoint();
  const navItems = BUSINESS_NAV;

  function isActive(item: NavItem) {
    return item.screens.includes(activeScreen);
  }

  const maxWidth = contentWidth === 'full' ? '100%' : contentWidth === 'wide' ? '800px' : '600px';

  // ── Desktop: sidebar + content ───────────────────────────────────────

  if (isDesktop) {
    return (
      <div style={styles.workspace}>
        {/* Sidebar */}
        <nav style={styles.sidebar} aria-label="Main navigation">
          {/* Business identity */}
          <div style={{ padding: '0 20px', marginBottom: '24px' }}>
            <div style={{
              fontSize: '11px', fontWeight: 500, textTransform: 'uppercase',
              letterSpacing: '0.1em', color: colors.dim, marginBottom: '6px',
            }}>
              neighborhood commons
            </div>
            {account?.business_name && (
              <div style={{ fontSize: '14px', fontWeight: 500, color: colors.heading, lineHeight: 1.3 }}>
                {account.business_name}
              </div>
            )}
          </div>

          {/* New Event button */}
          <div style={{ padding: '0 16px', marginBottom: '16px' }}>
            <button
              type="button"
              className="btn-primary"
              onClick={() => onNavigate('#/events/new')}
              style={{
                ...styles.buttonPrimary, padding: '9px 16px', fontSize: '13px',
              }}
            >
              + New Event
            </button>
          </div>

          {/* Nav items */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {navItems.filter(n => n.id !== 'new').map((item) => {
              const active = isActive(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  className="sidebar-nav-item"
                  onClick={() => onNavigate(item.hash)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '8px 20px', fontSize: '14px', cursor: 'pointer',
                    border: 'none', background: active ? colors.accentDim : 'none',
                    color: active ? colors.accent : colors.muted,
                    fontWeight: active ? 500 : 400,
                    width: '100%', textAlign: 'left', fontFamily: 'inherit', borderRadius: 0,
                  }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          {/* Sign out — bottom */}
          <div style={{ marginTop: 'auto', padding: '0 20px' }}>
            <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: '12px' }}>
              <button
                type="button"
                className="sidebar-nav-item"
                onClick={() => onSignOut()}
                style={{
                  display: 'flex', alignItems: 'center',
                  padding: '6px 0', fontSize: '13px', cursor: 'pointer',
                  border: 'none', background: 'none', color: colors.dim,
                  fontFamily: 'inherit',
                }}
              >
                Sign out
              </button>
            </div>
          </div>
        </nav>

        {/* Main canvas */}
        <div style={{
          ...styles.mainCanvas,
          marginLeft: '240px',
          paddingTop: '40px',
        }}>
          <div key={activeScreen} style={{ width: '100%', maxWidth, position: 'relative', zIndex: 1 }}>
            {children}
          </div>
        </div>
      </div>
    );
  }

  // ── Mobile: bottom tab bar + content ─────────────────────────────────

  return (
    <div style={{ minHeight: '100vh', background: colors.bg }}>
      {/* Content area — padded above and below for tab bar */}
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '16px 16px 80px',
      }}>
        <div key={activeScreen} style={{ width: '100%', maxWidth, position: 'relative', zIndex: 1 }}>
          {children}
        </div>
      </div>

      {/* Bottom tab bar */}
      <nav
        aria-label="Main navigation"
        style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          height: '64px', background: colors.card,
          borderTop: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-around',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          zIndex: 200,
        }}
      >
        {navItems.map((item) => {
          const active = isActive(item) || (item.id === 'dashboard' && activeScreen === 'dashboard');
          const isNewButton = item.id === 'new';
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.hash)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: '2px', border: 'none', background: 'none', cursor: 'pointer',
                padding: '6px 12px', fontFamily: 'inherit', minWidth: '48px',
                color: isNewButton ? colors.accent : active ? colors.accent : colors.dim,
                transition: 'color var(--motion-prop)',
              }}
              aria-label={item.label}
            >
              <span style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: isNewButton ? '36px' : '24px',
                height: isNewButton ? '36px' : '24px',
                ...(isNewButton ? {
                  background: colors.accent, borderRadius: radii.md,
                  color: '#fff',
                } : {}),
              }}>
                {item.icon}
              </span>
              {!isNewButton && (
                <span style={{
                  fontSize: '10px', fontWeight: active ? 600 : 400,
                  letterSpacing: '0.02em',
                }}>
                  {item.label}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
