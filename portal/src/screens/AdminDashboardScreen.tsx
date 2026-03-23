import { useState, useEffect, useCallback } from 'react';
import { styles, colors, radii, spacing } from '../lib/styles';
import {
  adminFetchStats, adminFetchAccounts, adminSeedAccount,
  adminApproveAccount, adminRejectAccount,
  type PortalAccount, type PortalStats, type SeedAccountParams,
} from '../lib/api';
import { StatCardSkeleton } from '../components/Skeleton';

interface AdminDashboardScreenProps {
  email: string;
  onViewAccount: (account: PortalAccount) => void;
  onViewAllEvents: () => void;
  onCreateEvent: () => void;
}

function timeAgo(date: string | null): string {
  if (!date) return 'Never';
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

function statusBadge(account: PortalAccount) {
  const status = account.status === 'pending' ? 'Pending'
    : account.status === 'rejected' ? 'Rejected'
    : account.status === 'suspended' ? 'Suspended'
    : account.claimed_at ? 'Claimed' : 'Managed';
  const bg = account.status === 'pending' ? colors.pendingBg
    : account.status === 'rejected' || account.status === 'suspended' ? colors.errorBg
    : account.claimed_at ? colors.successBg : colors.accentDim;
  const fg = account.status === 'pending' ? colors.pending
    : account.status === 'rejected' || account.status === 'suspended' ? colors.error
    : account.claimed_at ? colors.success : colors.accent;
  return { status, bg, fg };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function AdminDashboardScreen({ email: _email, onViewAccount, onViewAllEvents: _onViewAllEvents, onCreateEvent: _onCreateEvent }: AdminDashboardScreenProps) {
  void _email; void _onViewAllEvents; void _onCreateEvent; // available via sidebar nav
  const [stats, setStats] = useState<PortalStats | null>(null);
  const [accounts, setAccounts] = useState<PortalAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showSeedForm, setShowSeedForm] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [statsRes, accountsRes] = await Promise.all([adminFetchStats(), adminFetchAccounts()]);
    if (statsRes.data) setStats(statsRes.data.stats);
    if (accountsRes.data) setAccounts(accountsRes.data.accounts);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const pending = accounts.filter((a) => a.status === 'pending');
  const filtered = search
    ? accounts.filter((a) =>
        a.business_name.toLowerCase().includes(search.toLowerCase()) ||
        a.email.toLowerCase().includes(search.toLowerCase()))
    : accounts;

  return (
    <div style={{ maxWidth: '800px', width: '100%' }}>

      {/* Stats row */}
      {stats && (
        <div style={{ display: 'flex', gap: '12px', marginBottom: spacing.lg, flexWrap: 'wrap' }}>
          {[
            { label: 'Accounts', value: stats.total_accounts },
            { label: 'Claimed', value: stats.claimed_accounts },
            { label: 'Pending', value: stats.pending_accounts },
            { label: 'Events', value: stats.total_events },
            { label: 'This Week', value: stats.events_this_week },
          ].map((s) => (
            <div key={s.label} style={{
              flex: '1 1 100px', background: colors.card, border: `1px solid ${colors.border}`,
              borderRadius: radii.md, padding: '12px 14px', textAlign: 'center', minWidth: '80px',
            }}>
              <div className="tnum" style={{ fontSize: '22px', fontWeight: 600, color: colors.heading }}>{s.value}</div>
              <div style={{ fontSize: '10px', color: colors.dim, marginTop: '2px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Pending approvals */}
      {pending.length > 0 && (
        <div style={{
          background: colors.pendingBg, border: `1px solid ${colors.pendingBorder}`,
          borderRadius: radii.md, padding: '14px 16px', marginBottom: spacing.lg,
        }}>
          <div style={{ ...styles.sectionLabel, color: colors.pending, marginBottom: '10px' }}>
            Pending Verification ({pending.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {pending.map((account) => (
              <PendingRow
                key={account.id}
                account={account}
                onView={() => onViewAccount(account)}
                onApprove={async () => { await adminApproveAccount(account.id); loadData(); }}
                onReject={async () => { await adminRejectAccount(account.id); loadData(); }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Accounts header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={styles.sectionLabel}>Accounts ({accounts.length})</div>
        <button type="button" onClick={() => setShowSeedForm(!showSeedForm)}
          className="btn-text" style={{ ...styles.buttonText, fontSize: '12px' }}>
          {showSeedForm ? 'Cancel' : '+ Seed Account'}
        </button>
      </div>

      {/* Seed form */}
      {showSeedForm && (
        <div className="motion-fade-in" style={{ marginBottom: spacing.md }}>
          <SeedAccountForm onCreated={() => { loadData(); setShowSeedForm(false); }} />
        </div>
      )}

      {/* Search */}
      <input
        type="text" placeholder="Search accounts..."
        value={search} onChange={(e) => setSearch(e.target.value)}
        style={{ ...styles.input, marginBottom: '10px', padding: '8px 12px', fontSize: '14px' }}
      />

      {/* Account list */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <StatCardSkeleton /><StatCardSkeleton /><StatCardSkeleton />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          {filtered.map((account) => {
            const badge = statusBadge(account);
            return (
              <button key={account.id} type="button" className="interactive-row"
                onClick={() => onViewAccount(account)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  width: '100%', padding: '10px 14px', background: colors.card,
                  border: `1px solid ${colors.border}`, borderRadius: radii.sm,
                  cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '14px', fontWeight: 500, color: colors.heading,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {account.business_name}
                  </div>
                  <div style={{ fontSize: '12px', color: colors.dim, marginTop: '1px',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {account.email}
                  </div>
                </div>
                <span style={{
                  fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: radii.pill,
                  background: badge.bg, color: badge.fg, flexShrink: 0, letterSpacing: '0.02em',
                }}>
                  {badge.status}
                </span>
                <span className="tnum" style={{ fontSize: '12px', color: colors.dim, flexShrink: 0, minWidth: '50px', textAlign: 'right' }}>
                  {account.event_count || 0} events
                </span>
                <span className="tnum" style={{ fontSize: '11px', color: colors.dim, flexShrink: 0, minWidth: '55px', textAlign: 'right' }}>
                  {timeAgo(account.last_login_at)}
                </span>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ color: colors.dim, fontSize: '13px', padding: '24px', textAlign: 'center' }}>
              {search ? 'No accounts match your search' : 'No accounts yet'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending Row
// ---------------------------------------------------------------------------

function PendingRow({ account, onView, onApprove, onReject }: {
  account: PortalAccount; onView: () => void;
  onApprove: () => Promise<void>; onReject: () => Promise<void>;
}) {
  const [acting, setActing] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      padding: '8px 12px', background: colors.card,
      border: `1px solid ${colors.border}`, borderRadius: radii.sm,
    }}>
      <div style={{ flex: 1, cursor: 'pointer', minWidth: 0 }} onClick={onView}>
        <div style={{ fontSize: '14px', fontWeight: 500, color: colors.heading }}>{account.business_name}</div>
        <div style={{ fontSize: '12px', color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {account.email}
          {account.default_address && <> · {account.default_address}</>}
        </div>
      </div>
      {confirmReject ? (
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: '12px', color: colors.error }}>Reject?</span>
          <button type="button" disabled={acting}
            style={{ ...styles.buttonText, color: colors.error, fontSize: '12px', padding: '2px 6px' }}
            onClick={async () => { setActing(true); await onReject(); }}>
            Yes
          </button>
          <button type="button" style={{ ...styles.buttonText, fontSize: '12px', padding: '2px 6px' }}
            onClick={() => setConfirmReject(false)}>
            No
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
          <button type="button" className="btn-primary" disabled={acting}
            style={{ ...styles.buttonPrimary, width: 'auto', padding: '5px 14px', fontSize: '12px' }}
            onClick={async () => { setActing(true); await onApprove(); }}>
            {acting ? '...' : 'Approve'}
          </button>
          <button type="button" className="btn-text"
            style={{ ...styles.buttonText, color: colors.error, fontSize: '12px' }}
            onClick={() => setConfirmReject(true)}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Seed Form
// ---------------------------------------------------------------------------

function SeedAccountForm({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [venueName, setVenueName] = useState('');
  const [address, setAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !businessName) return;
    setSubmitting(true);
    setError('');
    const params: SeedAccountParams = {
      email, business_name: businessName,
      default_venue_name: venueName || undefined,
      default_address: address || undefined,
    };
    const res = await adminSeedAccount(params);
    setSubmitting(false);
    if (res.error) { setError(res.error.message); return; }
    setEmail(''); setBusinessName(''); setVenueName(''); setAddress('');
    onCreated();
  }

  return (
    <form onSubmit={handleSubmit} style={{
      background: colors.card, border: `1px solid ${colors.border}`,
      borderRadius: radii.md, padding: '14px',
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
        <input type="email" placeholder="Business email" value={email} onChange={(e) => setEmail(e.target.value)}
          style={{ ...styles.input, padding: '8px 10px', fontSize: '13px' }} required />
        <input type="text" placeholder="Business name" value={businessName} onChange={(e) => setBusinessName(e.target.value)}
          style={{ ...styles.input, padding: '8px 10px', fontSize: '13px' }} required />
        <input type="text" placeholder="Venue (optional)" value={venueName} onChange={(e) => setVenueName(e.target.value)}
          style={{ ...styles.input, padding: '8px 10px', fontSize: '13px' }} />
        <input type="text" placeholder="Address (optional)" value={address} onChange={(e) => setAddress(e.target.value)}
          style={{ ...styles.input, padding: '8px 10px', fontSize: '13px' }} />
      </div>
      {error && <div style={{ color: colors.error, fontSize: '12px', marginBottom: '6px' }}>{error}</div>}
      <button type="submit" className="btn-primary" disabled={submitting || !email || !businessName}
        style={{ ...styles.buttonPrimary, padding: '7px 16px', fontSize: '13px', width: 'auto' }}>
        {submitting ? 'Creating...' : 'Seed Account'}
      </button>
    </form>
  );
}
