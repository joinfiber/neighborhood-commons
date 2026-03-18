import { useState } from 'react';
import { colors, styles } from '../lib/styles';

interface SidebarProps {
  role: 'business' | 'admin';
  activeScreen: string;
  businessName?: string;
  businessAddress?: string;
  onNavigate: (hash: string) => void;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
  onClose?: () => void;
}

// Nav item configuration
interface NavItem {
  label: string;
  icon: React.ReactNode;
  hash: string;
  screens: string[]; // which route screens this item matches
}

const ICON_SIZE = 16;

// Inline SVG icons
const icons = {
  calendar: (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="11" rx="2" />
      <path d="M5 1v3M11 1v3M2 7h12" />
    </svg>
  ),
  import: (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v9M5 8l3 3 3-3" />
      <path d="M3 12v1.5h10V12" />
    </svg>
  ),
  share: (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12V14H12V12" />
      <path d="M8 10V3M5 5.5L8 2.5L11 5.5" />
    </svg>
  ),
  code: (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4L1.5 8 5 12M11 4l3.5 4L11 12" />
    </svg>
  ),
  person: (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="5" r="2.5" />
      <path d="M3 14c0-2.76 2.24-5 5-5s5 2.24 5 5" />
    </svg>
  ),
  people: (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="5" r="2" />
      <path d="M2 13c0-2.21 1.79-4 4-4s4 1.79 4 4" />
      <circle cx="11" cy="4.5" r="1.5" />
      <path d="M14 12.5c0-1.66-1.34-3-3-3-.55 0-1.07.15-1.5.41" />
    </svg>
  ),
  list: (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.5 4H14M5.5 8H14M5.5 12H14M2 4h.5M2 8h.5M2 12h.5" />
    </svg>
  ),
  mail: (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="3" width="13" height="10" rx="2" />
      <path d="M1.5 5l6.5 4 6.5-4" />
    </svg>
  ),
};

const BUSINESS_NAV: NavItem[] = [
  { label: 'Your Events', icon: icons.calendar, hash: '#/', screens: ['dashboard', 'edit-event', 'create-event'] },
  { label: 'Creative Tools', icon: icons.share, hash: '#/creative', screens: ['creative', 'share-event'] },
  { label: 'Developers', icon: icons.code, hash: '#/developers', screens: ['developers'] },
];

const ADMIN_NAV: NavItem[] = [
  { label: 'Accounts', icon: icons.people, hash: '#/admin', screens: ['admin-home', 'admin-account'] },
  { label: 'All Events', icon: icons.list, hash: '#/admin/events', screens: ['admin-events', 'admin-edit-event', 'admin-create-event'] },
  { label: 'Newsletters', icon: icons.mail, hash: '#/admin/newsletters', screens: ['admin-newsletters', 'admin-newsletter-emails', 'admin-newsletter-email', 'admin-newsletter-review'] },
];

const navItemBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '8px 20px',
  fontSize: '14px',
  cursor: 'pointer',
  border: 'none',
  background: 'none',
  width: '100%',
  textAlign: 'left',
  fontFamily: 'inherit',
  borderRadius: 0,
};

export function Sidebar({ role, activeScreen, businessName, businessAddress, onNavigate, onSignOut, onSignOutEverywhere, onClose }: SidebarProps) {
  const [confirmSignOutAll, setConfirmSignOutAll] = useState(false);
  const navItems = role === 'admin' ? ADMIN_NAV : BUSINESS_NAV;
  const heroLabel = role === 'admin' ? '+ Post Event' : '+ New Event';
  const heroHash = role === 'admin' ? '#/admin/events/new' : '#/events/new';

  function handleNav(hash: string) {
    if (!hash) return; // Share Studio is contextual, no direct nav
    onNavigate(hash);
    onClose?.();
  }

  function isActive(item: NavItem) {
    return item.screens.includes(activeScreen);
  }

  return (
    <nav style={styles.sidebar}>
      {/* Brand */}
      <div style={{ padding: '0 20px', marginBottom: '20px' }}>
        <div style={{
          fontSize: '11px',
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: colors.dim,
          marginBottom: '8px',
        }}>
          neighborhood commons
        </div>
        {businessName && (
          <>
            <div style={{
              fontSize: '14px',
              fontWeight: 500,
              color: colors.cream,
              lineHeight: 1.3,
            }}>
              {businessName}
            </div>
            {businessAddress && (
              <div style={{
                fontSize: '12px',
                color: colors.dim,
                marginTop: '2px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {businessAddress}
              </div>
            )}
          </>
        )}
      </div>

      {/* Hero CTA + Import */}
      <div style={{ padding: '0 16px', marginBottom: '16px' }}>
        <button
          type="button"
          className="btn-primary"
          onClick={() => handleNav(heroHash)}
          style={{
            ...styles.buttonPrimary,
            padding: '10px 16px',
            fontSize: '14px',
          }}
        >
          {heroLabel}
        </button>
        {role === 'business' && (
          <button
            type="button"
            className="sidebar-nav-item"
            onClick={() => handleNav('#/events/import')}
            style={{
              background: 'none',
              border: `1px solid ${activeScreen === 'import-events' ? colors.accent : colors.border}`,
              borderRadius: '6px',
              color: activeScreen === 'import-events' ? colors.accent : colors.muted,
              fontSize: '13px',
              cursor: 'pointer',
              padding: '7px 12px',
              marginTop: '8px',
              fontFamily: 'inherit',
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
            }}
          >
            {icons.import} Import Events
          </button>
        )}
      </div>

      {/* Nav items */}
      {navItems.map((item) => {
        const active = isActive(item);
        return (
          <button
            key={item.label}
            type="button"
            className="sidebar-nav-item"
            onClick={() => handleNav(item.hash)}
            style={{
              ...navItemBase,
              background: active ? colors.accentDim : 'none',
              color: active ? colors.accent : colors.muted,
              fontWeight: active ? 500 : 400,
            }}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}

      {/* Divider */}
      <div style={{ borderTop: `1px solid ${colors.border}`, margin: '8px 20px' }} />

      {/* Bottom section */}
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column' }}>
        {role === 'business' && (
          <>
            <div style={{ borderTop: `1px solid ${colors.border}`, margin: '0 20px 8px' }} />
            <button
              type="button"
              className="sidebar-nav-item"
              onClick={() => handleNav('#/profile')}
              style={{
                ...navItemBase,
                background: activeScreen === 'profile' ? colors.accentDim : 'none',
                color: activeScreen === 'profile' ? colors.accent : colors.muted,
                fontWeight: activeScreen === 'profile' ? 500 : 400,
              }}
            >
              {icons.person}
              Profile
            </button>
          </>
        )}

        {/* Sign out */}
        {confirmSignOutAll ? (
          <div style={{ padding: '8px 20px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '12px', color: colors.muted }}>Sign out all devices?</span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={() => { onSignOutEverywhere(); onClose?.(); }}
                style={{ ...navItemBase, padding: '4px 0', width: 'auto', fontSize: '12px', color: colors.error }}
              >
                Yes, everywhere
              </button>
              <button
                type="button"
                onClick={() => setConfirmSignOutAll(false)}
                style={{ ...navItemBase, padding: '4px 0', width: 'auto', fontSize: '12px', color: colors.dim }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div style={{ padding: '0 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              type="button"
              className="sidebar-nav-item"
              onClick={() => { onSignOut(); onClose?.(); }}
              style={{ ...navItemBase, padding: '8px 0', width: 'auto', color: colors.dim, fontSize: '13px' }}
            >
              Sign out
            </button>
            <button
              type="button"
              onClick={() => setConfirmSignOutAll(true)}
              style={{ ...navItemBase, padding: '4px 0', width: 'auto', color: colors.dim, fontSize: '11px' }}
              title="Sign out of all devices"
            >
              All devices
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
