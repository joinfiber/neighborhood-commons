import { useState, useEffect, useCallback } from 'react';
import { styles, colors } from '../lib/styles';
import {
  adminFetchStats, adminFetchAccounts, adminSeedAccount,
  adminApproveAccount, adminRejectAccount,
  type PortalAccount, type PortalStats, type SeedAccountParams,
} from '../lib/api';
import { StatCardSkeleton } from '../components/Skeleton';

interface AdminDashboardScreenProps {
  email: string;
  onSignOut: () => void;
  onViewAccount: (account: PortalAccount) => void;
  onViewAllEvents: () => void;
  onCreateEvent: () => void;
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div style={{
      background: colors.card,
      border: `1px solid ${colors.border}`,
      borderRadius: '10px',
      padding: '16px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: '28px', fontWeight: 600, color: colors.cream }}>{value}</div>
      <div style={{ fontSize: '12px', color: colors.muted, marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
    </div>
  );
}

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
      email,
      business_name: businessName,
      default_venue_name: venueName || undefined,
      default_address: address || undefined,
    };

    const res = await adminSeedAccount(params);
    setSubmitting(false);

    if (res.error) {
      setError(res.error.message);
      return;
    }

    setEmail('');
    setBusinessName('');
    setVenueName('');
    setAddress('');
    onCreated();
  }

  return (
    <form onSubmit={handleSubmit} style={{
      background: colors.card,
      border: `1px solid ${colors.border}`,
      borderRadius: '10px',
      padding: '16px',
      marginBottom: '24px',
    }}>
      <div style={{ ...styles.sectionLabel, marginBottom: '12px' }}>Seed Account</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
        <input type="email" placeholder="Business email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ ...styles.input, padding: '8px 10px', fontSize: '14px' }} required />
        <input type="text" placeholder="Business name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} style={{ ...styles.input, padding: '8px 10px', fontSize: '14px' }} required />
        <input type="text" placeholder="Default venue (optional)" value={venueName} onChange={(e) => setVenueName(e.target.value)} style={{ ...styles.input, padding: '8px 10px', fontSize: '14px' }} />
        <input type="text" placeholder="Default address (optional)" value={address} onChange={(e) => setAddress(e.target.value)} style={{ ...styles.input, padding: '8px 10px', fontSize: '14px' }} />
      </div>
      {error && <div style={{ color: colors.error, fontSize: '14px', marginBottom: '8px' }}>{error}</div>}
      <button type="submit" disabled={submitting || !email || !businessName} style={{ ...styles.buttonPrimary, padding: '8px 16px', fontSize: '14px', width: 'auto' }}>
        {submitting ? 'Creating...' : 'Seed Account'}
      </button>
    </form>
  );
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

export function AdminDashboardScreen({ email, onSignOut, onViewAccount, onViewAllEvents, onCreateEvent }: AdminDashboardScreenProps) {
  const [stats, setStats] = useState<PortalStats | null>(null);
  const [accounts, setAccounts] = useState<PortalAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    const [statsRes, accountsRes] = await Promise.all([
      adminFetchStats(),
      adminFetchAccounts(),
    ]);
    if (statsRes.data) setStats(statsRes.data.stats);
    if (accountsRes.data) setAccounts(accountsRes.data.accounts);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const filtered = search
    ? accounts.filter((a) =>
        a.business_name.toLowerCase().includes(search.toLowerCase()) ||
        a.email.toLowerCase().includes(search.toLowerCase()),
      )
    : accounts;

  return (
    <div style={styles.page}>
      <div style={styles.contentWide} className="fade-up">
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <div>
            <h1 style={{ ...styles.pageTitle, marginBottom: '4px' }}>neighborhood commons</h1>
            <div style={{ fontSize: '14px', color: colors.muted }}>{email}</div>
          </div>
          <button type="button" style={styles.buttonText} onClick={onSignOut}>Sign Out</button>
        </div>

        {/* Stats */}
        {stats && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '10px', marginBottom: '24px' }}>
            <StatCard label="Accounts" value={stats.total_accounts} />
            <StatCard label="Claimed" value={stats.claimed_accounts} />
            <StatCard label="Pending" value={stats.pending_accounts} />
            <StatCard label="Events" value={stats.total_events} />
            <StatCard label="This Week" value={stats.events_this_week} />
          </div>
        )}

        {/* Quick Actions */}
        <div style={{ display: 'flex', gap: '10px', marginBottom: '24px' }}>
          <button type="button" style={{ ...styles.buttonPrimary, flex: 1 }} onClick={onCreateEvent}>
            + Post Event
          </button>
          <button type="button" style={{ ...styles.buttonSecondary, flex: 1 }} onClick={onViewAllEvents}>
            All Events
          </button>
        </div>

        {/* Seed Form */}
        <SeedAccountForm onCreated={loadData} />

        {/* Pending Accounts (approve/reject) */}
        {accounts.filter((a) => a.status === 'pending').length > 0 && (
          <PendingAccountsSection
            accounts={accounts.filter((a) => a.status === 'pending')}
            onApprove={async (id) => {
              const res = await adminApproveAccount(id);
              if (res.data) loadData();
              return res;
            }}
            onReject={async (id) => {
              const res = await adminRejectAccount(id);
              if (res.data) loadData();
              return res;
            }}
            onViewAccount={onViewAccount}
          />
        )}

        {/* Accounts */}
        <div style={{ ...styles.sectionLabel, marginBottom: '12px' }}>
          Accounts ({accounts.length})
        </div>

        <input
          type="text"
          placeholder="Search accounts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...styles.input, marginBottom: '12px', padding: '8px 12px', fontSize: '14px' }}
        />

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {filtered.map((account) => (
              <button
                key={account.id}
                type="button"
                style={{
                  ...styles.eventRow,
                  display: 'grid',
                  gridTemplateColumns: '1fr auto auto auto',
                  gap: '12px',
                  alignItems: 'center',
                  background: 'transparent',
                  border: `1px solid ${colors.border}`,
                  cursor: 'pointer',
                  textAlign: 'left',
                  width: '100%',
                }}
                className="interactive-row"
                onClick={() => onViewAccount(account)}
              >
                <div>
                  <div style={{ fontSize: '16px', fontWeight: 500, color: colors.cream }}>{account.business_name}</div>
                  <div style={{ fontSize: '14px', color: colors.muted }}>{account.email}</div>
                </div>
                <span style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  background: account.status === 'pending' ? '#fef3cd' : account.claimed_at ? colors.successDim : colors.accentDim,
                  color: account.status === 'pending' ? '#92600a' : account.claimed_at ? colors.success : colors.accent,
                }}>
                  {account.status === 'pending' ? 'Pending' : account.status === 'rejected' ? 'Rejected' : account.claimed_at ? 'Claimed' : 'Managed'}
                </span>
                <div style={{ fontSize: '14px', color: colors.muted, textAlign: 'right', minWidth: '40px' }}>
                  {account.event_count || 0} events
                </div>
                <div style={{ fontSize: '12px', color: colors.dim, textAlign: 'right', minWidth: '60px' }}>
                  {timeAgo(account.last_login_at)}
                </div>
              </button>
            ))}
            {filtered.length === 0 && (
              <div style={{ color: colors.dim, fontSize: '14px', padding: '24px', textAlign: 'center' }}>
                {search ? 'No accounts match your search' : 'No accounts yet'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PendingAccountsSection({ accounts, onApprove, onReject, onViewAccount }: {
  accounts: PortalAccount[];
  onApprove: (id: string) => Promise<unknown>;
  onReject: (id: string) => Promise<unknown>;
  onViewAccount: (account: PortalAccount) => void;
}) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState<string | null>(null);

  return (
    <div style={{
      background: '#fef3cd',
      border: `1px solid #fde68a`,
      borderRadius: '10px',
      padding: '16px',
      marginBottom: '24px',
    }}>
      <div style={{ ...styles.sectionLabel, marginBottom: '12px', color: '#92600a' }}>
        Pending Verification ({accounts.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {accounts.map((account) => (
          <div key={account.id} style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '10px 12px',
            background: colors.card,
            border: `1px solid ${colors.border}`,
            borderRadius: '8px',
          }}>
            <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => onViewAccount(account)}>
              <div style={{ fontSize: '16px', fontWeight: 500, color: colors.cream }}>{account.business_name}</div>
              <div style={{ fontSize: '14px', color: colors.muted }}>
                {account.email}
                {account.default_address && <span> · {account.default_address}</span>}
                {account.website && <span> · {account.website}</span>}
              </div>
              <div style={{ fontSize: '12px', color: colors.dim, marginTop: '2px' }}>
                Registered {new Date(account.created_at).toLocaleDateString()}
                {account.event_count ? ` · ${account.event_count} events created` : ''}
              </div>
            </div>
            {confirmReject === account.id ? (
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', color: colors.error }}>Sure?</span>
                <button
                  type="button"
                  style={{ ...styles.buttonText, color: colors.error, fontSize: '14px' }}
                  disabled={actionLoading === account.id}
                  onClick={async () => {
                    setActionLoading(account.id);
                    await onReject(account.id);
                    setActionLoading(null);
                    setConfirmReject(null);
                  }}
                >
                  Yes, reject
                </button>
                <button
                  type="button"
                  style={{ ...styles.buttonText, fontSize: '14px' }}
                  onClick={() => setConfirmReject(null)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  style={{
                    background: colors.accent,
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '6px 14px',
                    fontSize: '14px',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                  disabled={actionLoading === account.id}
                  onClick={async () => {
                    setActionLoading(account.id);
                    await onApprove(account.id);
                    setActionLoading(null);
                  }}
                >
                  {actionLoading === account.id ? '...' : 'Approve'}
                </button>
                <button
                  type="button"
                  style={{ ...styles.buttonText, color: colors.error, fontSize: '14px' }}
                  onClick={() => setConfirmReject(account.id)}
                >
                  Reject
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
