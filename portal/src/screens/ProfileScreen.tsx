import { useState } from 'react';
import { styles, colors } from '../lib/styles';
import { updateProfile, type PortalAccount } from '../lib/api';
import { supabase } from '../lib/supabase';
import { PlaceAutocomplete } from '../components/PlaceAutocomplete';
import type { PlaceResult } from '../lib/types';

interface ProfileScreenProps {
  account: PortalAccount;
  onAccountUpdated: (account: PortalAccount) => void;
}

export function ProfileScreen({ account, onAccountUpdated }: ProfileScreenProps) {
  // Editable fields
  const [businessName, setBusinessName] = useState(account.business_name);
  const [venueName, setVenueName] = useState(account.default_venue_name || '');
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(null);
  const [website, setWebsite] = useState(account.website || '');
  const [phone, setPhone] = useState(account.phone || '');
  const [accessible, setAccessible] = useState(account.wheelchair_accessible);

  // Email change
  const [newEmail, setNewEmail] = useState('');
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [emailSending, setEmailSending] = useState(false);

  // Save state
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const isDirty =
    businessName !== account.business_name ||
    venueName !== (account.default_venue_name || '') ||
    selectedPlace !== null ||
    website !== (account.website || '') ||
    phone !== (account.phone || '') ||
    accessible !== account.wheelchair_accessible;

  const handleSave = async () => {
    setSaving(true);
    const params: Record<string, unknown> = {};

    if (businessName !== account.business_name) params.business_name = businessName;
    if (venueName !== (account.default_venue_name || '')) params.default_venue_name = venueName;
    if (selectedPlace) {
      params.default_place_id = selectedPlace.place_id;
      params.default_address = selectedPlace.address;
      params.default_latitude = selectedPlace.location?.latitude ?? null;
      params.default_longitude = selectedPlace.location?.longitude ?? null;
    }
    if (website !== (account.website || '')) params.website = website || null;
    if (phone !== (account.phone || '')) params.phone = phone || null;
    if (accessible !== account.wheelchair_accessible) params.wheelchair_accessible = accessible;

    if (Object.keys(params).length === 0) {
      setSaving(false);
      return;
    }

    const res = await updateProfile(params as Parameters<typeof updateProfile>[0]);
    setSaving(false);

    if (res.data?.account) {
      onAccountUpdated(res.data.account);
      setSelectedPlace(null);
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

    if (error) {
      setEmailStatus(error.message);
    } else {
      setEmailStatus('Check your new email for a confirmation link.');
      setNewEmail('');
    }
  };

  const section: React.CSSProperties = { marginBottom: '24px' };
  const sectionTitle: React.CSSProperties = {
    fontSize: '11px', fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.06em', color: colors.dim, marginBottom: '12px',
  };

  return (
    <>
      <h1 style={{ ...styles.pageTitle, marginBottom: '4px' }}>Profile</h1>
        <p style={{ fontSize: '13px', color: colors.muted, marginBottom: '24px' }}>
          Changes save when you press Save. Come back anytime.
        </p>

        {/* Toast */}
        {toast && (
          <div style={{
            background: toast.type === 'success' ? colors.successBg : colors.errorBg,
            color: toast.type === 'success' ? colors.success : colors.error,
            borderRadius: '6px', padding: '8px 12px', fontSize: '13px', marginBottom: '14px',
          }}>
            {toast.text}
          </div>
        )}

        {/* ── Business Info ── */}
        <div style={section}>
          <div style={sectionTitle}>Business</div>
          <div style={{ ...styles.card, display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={styles.formLabel}>Business name</label>
              <input
                type="text"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                style={styles.input}
              />
            </div>
            <div>
              <label style={styles.formLabel}>Default venue</label>
              <PlaceAutocomplete
                value={venueName}
                onChange={setVenueName}
                onSelect={(place) => {
                  setSelectedPlace(place);
                  setVenueName(place.name);
                }}
                placeholder="Search for your venue..."
              />
              {(selectedPlace?.address || account.default_address) && (
                <div style={{ fontSize: '12px', color: colors.muted, marginTop: '4px' }}>
                  {selectedPlace?.address || account.default_address}
                </div>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px' }}>
              <div>
                <label style={styles.formLabel}>Website</label>
                <input
                  type="url"
                  placeholder="https://yourbusiness.com"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  style={styles.input}
                />
              </div>
              <div>
                <label style={styles.formLabel}>Phone</label>
                <input
                  type="tel"
                  placeholder="(215) 555-0100"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  style={styles.input}
                />
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={accessible === true}
                onChange={(e) => setAccessible(e.target.checked ? true : null)}
                style={{ width: '16px', height: '16px' }}
              />
              <span style={{ fontSize: '14px', color: colors.text }}>Wheelchair accessible</span>
            </label>
          </div>
        </div>

        {/* Save button */}
        <button
          type="button"
          className="btn-primary"
          style={{ ...styles.buttonPrimary, marginBottom: '28px', opacity: isDirty ? 1 : 0.5 }}
          disabled={saving || !isDirty}
          onClick={handleSave}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>

        {/* ── Security ── */}
        <div style={section}>
          <div style={sectionTitle}>Security</div>
          <div style={{ ...styles.card, display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={styles.formLabel}>Email</label>
              <div style={{ fontSize: '14px', color: colors.text, marginBottom: '8px' }}>
                {account.email}
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <input
                    type="email"
                    placeholder="New email address"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    style={{ ...styles.input, fontSize: '14px' }}
                  />
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{
                    ...styles.buttonSecondary, width: 'auto',
                    padding: '10px 16px', fontSize: '13px', whiteSpace: 'nowrap',
                  }}
                  disabled={emailSending || !newEmail || newEmail === account.email}
                  onClick={handleEmailChange}
                >
                  {emailSending ? 'Sending...' : 'Change email'}
                </button>
              </div>
              {emailStatus && (
                <div style={{
                  fontSize: '12px', marginTop: '6px',
                  color: emailStatus.includes('Check') ? colors.success : colors.error,
                }}>
                  {emailStatus}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Account info */}
        <div style={{ fontSize: '12px', color: colors.dim, marginTop: '8px' }}>
          Account status: {account.status} · Member since {new Date(account.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
        </div>
    </>
  );
}
