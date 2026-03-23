/**
 * Portal Design Tokens
 *
 * Light work-focused palette for the logged-in portal.
 * loginColors preserves the dark brand palette for the marketing/login page.
 */

// ---------------------------------------------------------------------------
// Spacing & Radii — reference vocabulary for consistent sizing
// ---------------------------------------------------------------------------

export const radii = {
  sm: '6px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  pill: '9999px',
} as const;

export const spacing = {
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '32px',
  xxl: '48px',
} as const;

// ---------------------------------------------------------------------------
// Dark palette — used only by LoginScreen and marketing pages
// ---------------------------------------------------------------------------

export const loginColors = {
  accent: '#c4b89e',
  accentDim: '#c4b89e18',
  accentBorder: '#c4b89e30',
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

// ---------------------------------------------------------------------------
// Light work palette — every logged-in screen and component
// ---------------------------------------------------------------------------

export const colors = {
  // Core palette
  accent: '#2c2c2c',
  accentDim: '#2c2c2c06',
  accentBorder: '#2c2c2c15',
  bg: '#f7f7f5',
  card: '#ffffff',
  border: '#e8e6e1',

  // Typography hierarchy
  heading: '#1a1917',       // near-black — page titles, prominent text
  text: '#37352f',          // primary body text
  muted: '#6b6660',         // secondary text, labels
  dim: '#9c9791',           // tertiary text, placeholders, disabled

  // Semantic status
  error: '#c0392b',
  errorBg: '#fef2f2',
  errorBorder: '#f5c6c0',
  success: '#2d8a4e',
  successBg: '#ecfdf3',
  successBorder: '#b7e4c7',
  pending: '#92600a',
  pendingBg: '#fef9ee',
  pendingBorder: '#f5e6b8',

  // Legacy aliases
  cream: '#1a1917',
  successDim: '#ecfdf3',
} as const;

const inputBase: React.CSSProperties = {
  background: colors.card,
  border: `1px solid ${colors.border}`,
  borderRadius: '8px',
  color: colors.text,
  fontSize: '15px',
  padding: '10px 12px',
  outline: 'none',
  width: '100%',
  transition: 'border-color 0.15s',
};

export const styles = {
  // Layout
  page: {
    minHeight: '100vh',
    background: colors.bg,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    padding: '40px 20px',
    position: 'relative' as const,
    overflow: 'hidden' as const,
  },
  content: {
    width: '100%',
    maxWidth: '600px',
    position: 'relative' as const,
    zIndex: 1,
  },
  contentWide: {
    width: '100%',
    maxWidth: '800px',
    position: 'relative' as const,
    zIndex: 1,
  },
  loginContent: {
    width: '100%',
    maxWidth: '380px',
    position: 'relative' as const,
    zIndex: 1,
  },

  // Split layout (landing page — dark)
  splitLayout: {
    display: 'flex',
    minHeight: '100vh',
    background: loginColors.bg,
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
    borderRadius: '12px',
    padding: '24px',
  },

  // Typography
  pageTitle: {
    fontSize: '24px',
    fontWeight: 500 as const,
    color: colors.heading,
    letterSpacing: '0.01em',
  },
  sectionLabel: {
    fontSize: '13px',
    fontWeight: 600 as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: colors.muted,
  },
  formLabel: {
    fontSize: '14px',
    fontWeight: 500 as const,
    color: colors.text,
    marginBottom: '6px',
    display: 'block' as const,
  },
  helperText: {
    fontSize: '12px',
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
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' stroke='%236b6660' fill='none' stroke-width='1.5'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 12px center',
    paddingRight: '32px',
  },

  // Buttons
  buttonPrimary: {
    background: colors.accent,
    color: '#ffffff',
    border: 'none',
    borderRadius: '8px',
    padding: '12px 24px',
    fontSize: '15px',
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
    fontSize: '15px',
    fontWeight: 400,
    cursor: 'pointer',
    transition: 'border-color 0.15s',
  },
  buttonText: {
    background: 'none',
    border: 'none',
    color: colors.muted,
    fontSize: '13px',
    cursor: 'pointer',
    padding: '4px 8px',
  },

  // Pills
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: '16px',
    padding: '5px 12px',
    fontSize: '13px',
    cursor: 'pointer',
    transition: 'all 0.15s',
    border: '1px solid',
    userSelect: 'none' as const,
  },
  pillActive: {
    background: colors.accentDim,
    color: colors.accent,
    borderColor: colors.accentBorder,
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

  // Ambient glow — login/marketing pages only
  ambientGlow: {
    position: 'fixed' as const,
    top: '-200px',
    left: '50%',
    transform: 'translateX(-50%)',
    width: '600px',
    height: '600px',
    borderRadius: '50%',
    background: `radial-gradient(circle, ${loginColors.accent}0D 0%, transparent 70%)`,
    pointerEvents: 'none' as const,
    zIndex: 0,
    animation: 'drift 22s ease-in-out infinite',
  },

  // Workspace layout — sidebar CMS shell
  workspace: {
    display: 'flex',
    minHeight: '100vh',
    background: colors.bg,
  },
  sidebar: {
    width: '240px',
    background: colors.card,
    borderRight: `1px solid ${colors.border}`,
    display: 'flex',
    flexDirection: 'column' as const,
    padding: '20px 0',
    position: 'fixed' as const,
    top: 0,
    left: 0,
    height: '100vh',
    overflowY: 'auto' as const,
    zIndex: 100,
  },
  mainCanvas: {
    flex: 1,
    marginLeft: '240px',
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    padding: '40px 20px',
  },

  // Self-reflective title input — reads as a headline, not a text field
  titleInput: {
    fontSize: '20px',
    fontWeight: 600 as const,
    padding: '14px 16px',
    border: '1px solid transparent',
    borderRadius: radii.md,
    background: 'transparent',
    color: colors.heading,
    letterSpacing: '-0.01em',
    outline: 'none',
    width: '100%',
    transition: 'border-color 0.15s, background 0.15s',
  },

  // Form field grouping
  fieldGroup: {
    marginBottom: spacing.lg,
  },
  fieldDivider: {
    border: 'none',
    borderTop: `1px solid ${colors.border}`,
    margin: `${spacing.xl} 0`,
  },

  // Tooltip
  tooltipIcon: {
    display: 'inline-flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    width: '16px',
    height: '16px',
    borderRadius: '50%',
    border: `1px solid ${colors.border}`,
    background: 'transparent',
    color: colors.dim,
    fontSize: '10px',
    cursor: 'help',
    marginLeft: '6px',
    padding: 0,
    lineHeight: 1,
    fontFamily: 'inherit',
    verticalAlign: 'middle' as const,
  },
  tooltipContent: {
    position: 'absolute' as const,
    background: colors.heading,
    color: '#e8e6e1',
    fontSize: '12px',
    lineHeight: '1.5',
    padding: '8px 12px',
    borderRadius: radii.md,
    maxWidth: '220px',
    zIndex: 200,
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  },

  // Accessibility
  srOnly: {
    position: 'absolute' as const,
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden' as const,
    clip: 'rect(0,0,0,0)',
    whiteSpace: 'nowrap' as const,
    border: 0,
  },

  // Optional label treatment
  optionalLabel: {
    color: colors.dim,
    fontWeight: 400 as const,
    fontSize: '12px',
  },

  // Mobile sticky submit
  stickySubmit: {
    position: 'sticky' as const,
    bottom: 0,
    background: colors.bg,
    padding: '12px 0',
    marginTop: spacing.sm,
    zIndex: 10,
    borderTop: `1px solid ${colors.border}`,
  },
} as const;

// ---------------------------------------------------------------------------
// Dark login styles — mirrors key shared styles using loginColors
// ---------------------------------------------------------------------------

const loginInputBase: React.CSSProperties = {
  background: loginColors.bg,
  border: `1px solid ${loginColors.border}`,
  borderRadius: '8px',
  color: loginColors.text,
  fontSize: '14px',
  padding: '10px 12px',
  outline: 'none',
  width: '100%',
  transition: 'border-color 0.15s',
};

export const loginStyles = {
  page: {
    ...styles.page,
    background: loginColors.bg,
  },
  card: {
    background: loginColors.card,
    border: `1px solid ${loginColors.border}`,
    borderRadius: '14px',
    padding: '24px',
  },
  input: loginInputBase,
  buttonPrimary: {
    background: loginColors.accent,
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
  buttonText: {
    background: 'none',
    border: 'none',
    color: loginColors.muted,
    fontSize: '12px',
    cursor: 'pointer',
    padding: '4px 8px',
  },
  pageTitle: {
    fontSize: '20px',
    fontWeight: 300,
    color: loginColors.cream,
    letterSpacing: '0.06em',
  },
  formLabel: {
    fontSize: '12px',
    color: loginColors.muted,
    letterSpacing: '0.04em',
    marginBottom: '6px',
    display: 'block' as const,
  },
} as const;

// Animations and interactive styles are in portal.css
