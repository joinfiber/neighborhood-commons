import { useState, useEffect } from 'react';
import { colors, styles } from '../lib/styles';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { Sidebar } from './Sidebar';
import type { PortalAccount } from '../lib/api';

interface WorkspaceShellProps {
  children: React.ReactNode;
  activeScreen: string;
  contentWidth?: 'normal' | 'wide';
  role: 'business' | 'admin';
  account?: PortalAccount | null;
  onNavigate: (hash: string) => void;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
}

export function WorkspaceShell({
  children,
  activeScreen,
  contentWidth = 'normal',
  role,
  account,
  onNavigate,
  onSignOut,
  onSignOutEverywhere,
}: WorkspaceShellProps) {
  const { isDesktop } = useBreakpoint();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close sidebar on navigation (mobile)
  useEffect(() => {
    if (!isDesktop) setSidebarOpen(false);
  }, [activeScreen, isDesktop]);

  const maxWidth = contentWidth === 'wide' ? '800px' : '600px';

  return (
    <div style={styles.workspace}>
      {/* Desktop: fixed sidebar */}
      {isDesktop && (
        <Sidebar
          role={role}
          activeScreen={activeScreen}
          businessName={account?.business_name}
          businessAddress={account?.default_address || undefined}
          onNavigate={onNavigate}
          onSignOut={onSignOut}
          onSignOutEverywhere={onSignOutEverywhere}
        />
      )}

      {/* Mobile/Tablet: top bar + overlay sidebar */}
      {!isDesktop && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: '48px',
          background: colors.card,
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          zIndex: 101,
        }}>
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
            }}
            aria-label="Open navigation"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={colors.text} strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 5h14M3 10h14M3 15h14" />
            </svg>
          </button>
          <span style={{
            fontSize: '11px',
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            color: colors.dim,
            marginLeft: '12px',
          }}>
            neighborhood commons
          </span>
        </div>
      )}

      {/* Mobile sidebar overlay */}
      {!isDesktop && sidebarOpen && (
        <>
          <div
            className="sidebar-overlay-backdrop"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="sidebar-slide-in" style={{ position: 'fixed', top: 0, left: 0, zIndex: 100 }}>
            <Sidebar
              role={role}
              activeScreen={activeScreen}
              businessName={account?.business_name}
              businessAddress={account?.default_address || undefined}
              onNavigate={onNavigate}
              onSignOut={onSignOut}
              onSignOutEverywhere={onSignOutEverywhere}
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </>
      )}

      {/* Main canvas */}
      <div style={{
        ...styles.mainCanvas,
        marginLeft: isDesktop ? '240px' : 0,
        paddingTop: isDesktop ? '40px' : '68px', // account for mobile top bar
      }}>
        <div
          key={activeScreen}
          className="fade-up"
          style={{
            width: '100%',
            maxWidth,
            position: 'relative',
            zIndex: 1,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
