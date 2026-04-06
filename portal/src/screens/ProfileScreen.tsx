import { useState } from 'react';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { styles, colors, radii, spacing } from '../lib/styles';
import { updateProfile, type PortalAccount } from '../lib/api';
import { supabase } from '../lib/supabase';

interface ProfileScreenProps {
  account: PortalAccount;
  onAccountUpdated: (account: PortalAccount) => void;
}

export function ProfileScreen({ account, onAccountUpdated }: ProfileScreenProps) {
  const { isDesktop } = useBreakpoint();

  // Editable fields
  const [displayName, setDisplayName] = useState(account.business_name);
  const [website, setWebsite] = useState(account.website || '');
  const [phone, setPhone] = useState(account.phone || '');

  // Email change
  const [newEmail, setNewEmail] = useState('');
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [emailSending, setEmailSending] = useState(false);

  // Save state
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const isDirty =
    displayName !== account.business_name ||
    website !== (account.website || '') ||
    phone !== (account.phone || '');

  const handleSave = async () => {
    setSaving(true);
    const params: Record<string, unknown> = {};
    if (displayName !== account.business_name) params.business_name = displayName;
    if (website !== (account.website || '')) params.website = website || null;
    if (phone !== (account.phone || '')) params.phone = phone || null;

    if (Object.keys(params).length === 0) { setSaving(false); return; }

    const res = await updateProfile(params as Parameters<typeof updateProfile>[0]);
    setSaving(false);
    if (res.data?.account) {
      onAccountUpdated(res.data.account);
      setToast({ text: 'Profile updated', type: 'success' });
      setTimeout(() => setToast(null), 3000);
    } else {
      setToast({ text: res.error?.message || 'Failed to save', type: 'error' });
      setTimeout(() => setToast(null), 4000);
    }
  };

  const handleEmailChange = async () => {
    if (!newEmail || newEmail === account.email) return;
    setEmailSending(true);
    setEmailStatus(null);
    const { error } = await supabase.auth.updateUser({ email: newEmail });
    setEmailSending(false);
    if (error) setEmailStatus(error.message);
    else { setEmailStatus('Check your new email for a confirmation link.'); setNewEmail(''); }
  };

  // ── Contributor Card Preview ───────────────────────────────────────────

  const contributorCard = (
    <div style={{
      background: colors.card, border: `1px solid ${colors.border}`,
      borderRadius: radii.lg, padding: '20px',
    }}>
      <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: colors.dim, marginBottom: '12px' }}>
        Contributor
      </div>

      <div style={{ fontSize: '18px', fontWeight: 600, color: colors.heading, lineHeight: 1.3, marginBottom: '6px' }}>
        {displayName || <span style={{ color: colors.dim }}>Display name</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {website ? (
          <div style={{ fontSize: '13px', color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {website.replace(/^https?:\/\//, '')}
          </div>
        ) : (
          <div style={{ fontSize: '13px', color: colors.dim, fontStyle: 'italic' }}>No website</div>
        )}
        {phone ? (
          <div style={{ fontSize: '13px', color: colors.text }}>{phone}</div>
        ) : (
          <div style={{ fontSize: '13px', color: colors.dim, fontStyle: 'italic' }}>No phone</div>
        )}
      </div>

      <div style={{ borderTop: `1px solid ${colors.border}`, marginTop: '10px', paddingTop: '10px',
        fontSize: '11px', color: colors.dim }}>
        {account.email} · Member since {new Date(account.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
      </div>
    </div>
  );

  // ── Edit Form ─────────────────────────────────────────────────────────

  const editForm = (
    <div>
      {/* Toast */}
      {toast && (
        <div style={{
          background: toast.type === 'success' ? colors.successBg : colors.errorBg,
          color: toast.type === 'success' ? colors.success : colors.error,
          borderRadius: radii.sm, padding: '8px 12px', fontSize: '13px', marginBottom: '16px',
        }}>
          {toast.text}
        </div>
      )}

      {/* Display name */}
      <div style={{ marginBottom: spacing.lg }}>
        <label style={styles.formLabel}>Display name</label>
        <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
          style={styles.input} />
        <p style={styles.helperText}>
          Shows in contributor attribution on events you contribute.
        </p>
      </div>

      {/* Website + Phone */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: spacing.lg }}>
        <div>
          <label style={styles.formLabel}>Website</label>
          <input type="url" placeholder="https://yourproject.com" value={website}
            onChange={(e) => setWebsite(e.target.value)} style={styles.input} />
        </div>
        <div>
          <label style={styles.formLabel}>Phone</label>
          <input type="tel" placeholder="(215) 555-0100" value={phone}
            onChange={(e) => setPhone(e.target.value)} style={styles.input} />
        </div>
      </div>

      {/* Save */}
      <button type="button" className="btn-primary"
        style={{ ...styles.buttonPrimary, marginBottom: spacing.xl, opacity: isDirty ? 1 : 0.5 }}
        disabled={saving || !isDirty} onClick={handleSave}>
        {saving ? 'Saving...' : 'Save'}
      </button>

      {/* ── Email ── */}
      <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: spacing.lg }}>
        <div style={{ ...styles.sectionLabel, marginBottom: '12px' }}>Account</div>
        <div style={{ fontSize: '14px', color: colors.text, marginBottom: '8px' }}>
          {account.email}
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <input type="email" placeholder="New email address" value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)} style={{ ...styles.input, fontSize: '14px' }} />
          </div>
          <button type="button" className="btn-secondary"
            style={{ ...styles.buttonSecondary, width: 'auto', padding: '10px 16px', fontSize: '13px', whiteSpace: 'nowrap' }}
            disabled={emailSending || !newEmail || newEmail === account.email}
            onClick={handleEmailChange}>
            {emailSending ? 'Sending...' : 'Change email'}
          </button>
        </div>
        {emailStatus && (
          <div style={{ fontSize: '12px', marginTop: '6px',
            color: emailStatus.includes('Check') ? colors.success : colors.error }}>
            {emailStatus}
          </div>
        )}
      </div>
    </div>
  );

  // ── Layout ────────────────────────────────────────────────────────────

  if (isDesktop) {
    return (
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 300px', gap: spacing.xxl,
        maxWidth: '920px', width: '100%', alignItems: 'start',
      }}>
        <div>{editForm}</div>
        <div style={{ position: 'sticky', top: '40px' }}>
          {contributorCard}
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '600px', width: '100%' }}>
      <div style={{ marginBottom: spacing.lg }}>{contributorCard}</div>
      {editForm}
    </div>
  );
}
