import { useState } from 'react';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { styles, colors, radii, spacing } from '../lib/styles';
import { updateProfile, type PortalAccount } from '../lib/api';
import { supabase } from '../lib/supabase';
import { PlaceAutocomplete } from '../components/PlaceAutocomplete';
import { OperatingHours, emptyWeek, type WeekHours } from '../components/OperatingHours';
import type { PlaceResult } from '../lib/types';

interface ProfileScreenProps {
  account: PortalAccount;
  onAccountUpdated: (account: PortalAccount) => void;
}

export function ProfileScreen({ account, onAccountUpdated }: ProfileScreenProps) {
  const { isDesktop } = useBreakpoint();

  // Editable fields
  const [businessName, setBusinessName] = useState(account.business_name);
  const [venueName, setVenueName] = useState(account.default_venue_name || '');
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(null);
  const [website, setWebsite] = useState(account.website || '');
  const [phone, setPhone] = useState(account.phone || '');
  const [accessible, setAccessible] = useState(account.wheelchair_accessible);
  const [operatingHours, setOperatingHours] = useState<WeekHours>(() => {
    // Parse from account if stored, otherwise start empty
    try {
      const stored = (account as unknown as Record<string, unknown>).operating_hours;
      if (stored && Array.isArray(stored) && stored.length === 7) return stored as WeekHours;
    } catch { /* ignore */ }
    return emptyWeek();
  });
  const [hoursExpanded, setHoursExpanded] = useState(() => {
    return operatingHours.some(d => d.open);
  });

  // Email change
  const [newEmail, setNewEmail] = useState('');
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [emailSending, setEmailSending] = useState(false);

  // Save state
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const currentAddress = selectedPlace?.address || account.default_address || '';

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

    if (Object.keys(params).length === 0) { setSaving(false); return; }

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
    if (error) setEmailStatus(error.message);
    else { setEmailStatus('Check your new email for a confirmation link.'); setNewEmail(''); }
  };

  // ── Business Card Preview ─────────────────────────────────────────────

  const businessCard = (
    <div style={{
      background: colors.card, border: `1px solid ${colors.border}`,
      borderRadius: radii.lg, padding: '20px',
    }}>
      <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: colors.dim, marginBottom: '12px' }}>
        Your business
      </div>

      <div style={{ fontSize: '18px', fontWeight: 600, color: colors.heading, lineHeight: 1.3, marginBottom: '6px' }}>
        {businessName || <span style={{ color: colors.dim }}>Business name</span>}
      </div>

      {(venueName || currentAddress) && (
        <div style={{ marginBottom: '8px' }}>
          {venueName && (
            <div style={{ fontSize: '14px', color: colors.muted }}>{venueName}</div>
          )}
          {currentAddress && (
            <div style={{ fontSize: '13px', color: colors.dim }}>{currentAddress}</div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {phone ? (
          <div style={{ fontSize: '13px', color: colors.text }}>{phone}</div>
        ) : (
          <div style={{ fontSize: '13px', color: colors.dim, fontStyle: 'italic' }}>No phone</div>
        )}
        {website ? (
          <div style={{ fontSize: '13px', color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {website.replace(/^https?:\/\//, '')}
          </div>
        ) : (
          <div style={{ fontSize: '13px', color: colors.dim, fontStyle: 'italic' }}>No website</div>
        )}
      </div>

      {accessible && (
        <div style={{ fontSize: '12px', color: colors.success, marginTop: '8px' }}>
          ♿ Wheelchair accessible
        </div>
      )}

      {/* Operating hours summary */}
      {operatingHours.some(d => d.open) && (
        <div style={{ marginTop: '12px', borderTop: `1px solid ${colors.border}`, paddingTop: '10px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: colors.dim, marginBottom: '6px',
            textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Hours
          </div>
          {operatingHours.map((day, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px',
              color: day.open ? colors.text : colors.dim, lineHeight: 1.8 }}>
              <span>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]}</span>
              <span className="tnum">
                {day.open && day.ranges.length > 0
                  ? day.ranges.map(r => {
                      const fmtT = (t: string) => {
                        const [hh, mm] = t.split(':');
                        const h = parseInt(hh!, 10);
                        return `${h % 12 || 12}${mm === '00' ? '' : ':' + mm}${h >= 12 ? 'p' : 'a'}`;
                      };
                      return `${fmtT(r.start)}–${fmtT(r.end)}`;
                    }).join(', ')
                  : 'Closed'}
              </span>
            </div>
          ))}
        </div>
      )}

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

      {/* Business name */}
      <div style={{ marginBottom: spacing.lg }}>
        <label style={styles.formLabel}>Business name</label>
        <input type="text" value={businessName} onChange={(e) => setBusinessName(e.target.value)}
          style={styles.input} />
      </div>

      {/* Venue */}
      <div style={{ marginBottom: spacing.lg }}>
        <label style={styles.formLabel}>Default venue</label>
        <PlaceAutocomplete
          value={venueName}
          onChange={setVenueName}
          onSelect={(place) => { setSelectedPlace(place); setVenueName(place.name); }}
          placeholder="Search for your venue..."
        />
        {currentAddress && (
          <div style={{ fontSize: '12px', color: colors.muted, marginTop: '4px' }}>
            {currentAddress}
          </div>
        )}
      </div>

      {/* Website + Phone */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: spacing.lg }}>
        <div>
          <label style={styles.formLabel}>Website</label>
          <input type="url" placeholder="https://yourbusiness.com" value={website}
            onChange={(e) => setWebsite(e.target.value)} style={styles.input} />
        </div>
        <div>
          <label style={styles.formLabel}>Phone</label>
          <input type="tel" placeholder="(215) 555-0100" value={phone}
            onChange={(e) => setPhone(e.target.value)} style={styles.input} />
        </div>
      </div>

      {/* Accessible */}
      <div style={{ marginBottom: spacing.lg }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <input type="checkbox" checked={accessible === true}
            onChange={(e) => setAccessible(e.target.checked ? true : null)}
            style={{ width: '16px', height: '16px' }} />
          <span style={{ fontSize: '14px', color: colors.text }}>Wheelchair accessible</span>
        </label>
      </div>

      {/* Operating Hours */}
      <div style={{ marginBottom: spacing.lg }}>
        <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: spacing.lg, marginTop: spacing.sm }}>
          {hoursExpanded ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <div style={{ ...styles.sectionLabel, margin: 0 }}>Operating Hours</div>
                {!operatingHours.some(d => d.open) && (
                  <button type="button" onClick={() => setHoursExpanded(false)}
                    className="btn-text" style={{ ...styles.buttonText, fontSize: '12px', padding: 0 }}>
                    Collapse
                  </button>
                )}
              </div>
              <OperatingHours value={operatingHours} onChange={setOperatingHours} />
            </div>
          ) : (
            <button type="button" onClick={() => setHoursExpanded(true)}
              className="btn-text"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
                color: colors.muted, fontSize: '13px', cursor: 'pointer', padding: '0', fontFamily: 'inherit' }}>
              <span style={{ fontSize: '15px', lineHeight: 1, fontWeight: 300 }}>+</span>
              Add operating hours
            </button>
          )}
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
          {businessCard}
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '600px', width: '100%' }}>
      <div style={{ marginBottom: spacing.lg }}>{businessCard}</div>
      {editForm}
    </div>
  );
}
