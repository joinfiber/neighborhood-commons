import { useState, useEffect, useCallback } from 'react';
import { styles, colors } from '../lib/styles';
import { adminFetchAccounts, type PortalAccount } from '../lib/api';
import { EventRowSkeleton } from '../components/Skeleton';

interface AdminVenuesScreenProps {
  onNavigate: (hash: string) => void;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function AdminVenuesScreen({ onNavigate }: AdminVenuesScreenProps) {
  const [accounts, setAccounts] = useState<PortalAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    const res = await adminFetchAccounts();
    if (res.data?.accounts) setAccounts(res.data.accounts);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const filtered = accounts
    .filter((a) => {
      if (!search) return true;
      const s = search.toLowerCase();
      return (
        (a.default_venue_name || '').toLowerCase().includes(s) ||
        a.business_name.toLowerCase().includes(s) ||
        a.email.toLowerCase().includes(s)
      );
    })
    .sort((a, b) => (b.event_count || 0) - (a.event_count || 0));

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <h1 style={styles.pageTitle}>Venues</h1>
        <span style={{ fontSize: '14px', color: colors.muted }}>({filtered.length})</span>
      </div>

      <input
        type="text"
        placeholder="Search venues or businesses..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ ...styles.input, marginBottom: '16px', padding: '8px 12px', fontSize: '14px' }}
      />

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <EventRowSkeleton />
          <EventRowSkeleton />
          <EventRowSkeleton />
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ color: colors.dim, fontSize: '14px', padding: '24px', textAlign: 'center' }}>
          {search ? 'No venues match your search' : 'No venues yet'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: '11px', fontWeight: 600, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Venue / Business Name</th>
                <th style={{ textAlign: 'right', padding: '8px 10px', fontSize: '11px', fontWeight: 600, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Events</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: '11px', fontWeight: 600, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: '11px', fontWeight: 600, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Last Login</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr
                  key={a.id}
                  className="interactive-row"
                  onClick={() => onNavigate(`#/admin/accounts/${a.id}`)}
                  style={{ borderBottom: `1px solid ${colors.border}`, cursor: 'pointer' }}
                >
                  <td style={{ padding: '10px 10px' }}>
                    <div style={{ color: colors.cream, fontWeight: 500 }}>
                      {a.default_venue_name || a.business_name}
                    </div>
                    {a.default_venue_name && a.default_venue_name !== a.business_name && (
                      <div style={{ fontSize: '12px', color: colors.dim, marginTop: '2px' }}>
                        {a.business_name}
                      </div>
                    )}
                  </td>
                  <td className="tnum" style={{ padding: '10px 10px', textAlign: 'right', color: colors.muted, fontWeight: 500 }}>
                    {a.event_count || 0}
                  </td>
                  <td style={{ padding: '10px 10px' }}>
                    <span style={{
                      fontSize: '11px', padding: '2px 8px', borderRadius: '10px',
                      background: a.status === 'active' ? colors.successBg : a.status === 'pending' ? colors.pendingBg : colors.errorBg,
                      color: a.status === 'active' ? colors.success : a.status === 'pending' ? colors.pending : colors.error,
                    }}>
                      {a.status}
                    </span>
                  </td>
                  <td style={{ padding: '10px 10px', color: colors.dim, whiteSpace: 'nowrap' }}>
                    {formatDate(a.last_login_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
