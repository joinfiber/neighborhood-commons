/**
 * Portal Design Tokens
 * From fiber-events-portal-spec.md section 2
 */

export const colors = {
  amber: '#D4A853',
  amberDim: '#D4A85318',
  amberBorder: '#D4A85344',
  bg: '#0f0f0e',
  card: '#181715',
  border: '#2a2825',
  cream: '#f5f0e8',
  text: '#d4d0c8',
  muted: '#7a7670',
  dim: '#4a4740',
  error: '#D4725C',
  success: '#7A9E7E',
  successDim: '#7A9E7E18',
} as const;

const inputBase: React.CSSProperties = {
  background: colors.bg,
  border: `1px solid ${colors.border}`,
  borderRadius: '8px',
  color: colors.text,
  fontSize: '14px',
  padding: '10px 12px',
  outline: 'none',
  width: '100%',
  transition: 'border-color 0.15s',
};

export const styles = {
  // Layout
  page: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    padding: '40px 20px',
    position: 'relative' as const,
    overflow: 'hidden' as const,
  },
  content: {
    width: '100%',
    maxWidth: '540px',
    position: 'relative' as const,
    zIndex: 1,
  },
  contentWide: {
    width: '100%',
    maxWidth: '720px',
    position: 'relative' as const,
    zIndex: 1,
  },
  loginContent: {
    width: '100%',
    maxWidth: '380px',
    position: 'relative' as const,
    zIndex: 1,
  },

  // Split layout (landing page)
  splitLayout: {
    display: 'flex',
    minHeight: '100vh',
    position: 'relative' as const,
    overflow: 'hidden' as const,
  },
  marketingColumn: {
    flex: '1 1 55%',
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'center',
    padding: '60px 48px 60px 64px',
    position: 'relative' as const,
    zIndex: 1,
  },
  loginColumn: {
    flex: '1 1 45%',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    padding: '60px 48px',
    position: 'relative' as const,
    zIndex: 1,
  },

  // Cards
  card: {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: '14px',
    padding: '24px',
  },

  // Typography
  pageTitle: {
    fontSize: '20px',
    fontWeight: 300,
    color: colors.cream,
    letterSpacing: '0.06em',
  },
  sectionLabel: {
    fontSize: '11px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    color: colors.dim,
  },
  formLabel: {
    fontSize: '12px',
    color: colors.muted,
    letterSpacing: '0.04em',
    marginBottom: '6px',
    display: 'block' as const,
  },
  helperText: {
    fontSize: '10px',
    color: colors.dim,
    marginTop: '4px',
  },

  // Inputs
  input: inputBase,
  textarea: {
    ...inputBase,
    resize: 'vertical' as const,
    minHeight: '80px',
  },
  select: {
    ...inputBase,
    appearance: 'none' as const,
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' stroke='%237a7670' fill='none' stroke-width='1.5'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 12px center',
    paddingRight: '32px',
  },

  // Buttons
  buttonPrimary: {
    background: colors.amber,
    color: '#0f0f0e',
    border: 'none',
    borderRadius: '8px',
    padding: '12px 24px',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    width: '100%',
    transition: 'opacity 0.15s, transform 0.15s',
  },
  buttonSecondary: {
    background: 'transparent',
    color: colors.text,
    border: `1px solid ${colors.border}`,
    borderRadius: '8px',
    padding: '12px 24px',
    fontSize: '14px',
    fontWeight: 400,
    cursor: 'pointer',
    transition: 'border-color 0.15s',
  },
  buttonText: {
    background: 'none',
    border: 'none',
    color: colors.muted,
    fontSize: '12px',
    cursor: 'pointer',
    padding: '4px 8px',
  },

  // Pills
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: '16px',
    padding: '5px 12px',
    fontSize: '12px',
    cursor: 'pointer',
    transition: 'all 0.15s',
    border: '1px solid',
    userSelect: 'none' as const,
  },
  pillActive: {
    background: colors.amberDim,
    color: colors.amber,
    borderColor: colors.amberBorder,
  },
  pillInactive: {
    background: 'transparent',
    color: colors.dim,
    borderColor: colors.border,
  },

  // Event row
  eventRow: {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: '10px',
    padding: '14px 16px',
    cursor: 'pointer',
    transition: 'border-color 0.15s',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  // Divider
  divider: {
    border: 'none',
    borderTop: `1px solid ${colors.border}`,
    margin: '6px 0',
  },

  // Ambient glow
  ambientGlow: {
    position: 'fixed' as const,
    top: '-200px',
    left: '50%',
    transform: 'translateX(-50%)',
    width: '600px',
    height: '600px',
    borderRadius: '50%',
    background: `radial-gradient(circle, ${colors.amber}0D 0%, transparent 70%)`,
    pointerEvents: 'none' as const,
    zIndex: 0,
    animation: 'drift 22s ease-in-out infinite',
  },
} as const;

// Animations and interactive styles are in portal.css
