import { useState, useEffect } from 'react';
import { colors, styles } from '../lib/styles';
import { fetchBatches } from '../lib/api';
import type { PortalAccount, ContributionBatch } from '../lib/api';

// =============================================================================
// TYPES
// =============================================================================

interface ContributionsScreenProps {
  account: PortalAccount;
  onNavigate: (screen: string) => void;
}

// =============================================================================
// STATUS HELPERS
// =============================================================================

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  draft: { label: 'Draft', color: colors.dim, bg: colors.bg, border: colors.border },
  submitted: { label: 'Submitted', color: colors.pending, bg: colors.pendingBg, border: colors.pendingBorder },
  approved: { label: 'Approved', color: colors.success, bg: colors.successBg, border: colors.successBorder },
  partially_approved: { label: 'Partially Approved', color: colors.pending, bg: colors.pendingBg, border: colors.pendingBorder },
  rejected: { label: 'Rejected', color: colors.error, bg: colors.errorBg, border: colors.errorBorder },
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

// =============================================================================
// SCREEN
// =============================================================================

export function ContributionsScreen({ account, onNavigate }: ContributionsScreenProps) {
  const [batches, setBatches] = useState<ContributionBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadBatches();
  }, []);

  async function loadBatches() {
    setLoading(true);
    const res = await fetchBatches();
    setLoading(false);

    if (res.error) {
      setError(res.error.message);
      return;
    }

    setBatches(res.data?.batches || []);
  }

  const totalEvents = batches.reduce((sum, b) => sum + b.created_events, 0);

  return (
    <>
      <h1 style={{ ...styles.pageTitle, marginBottom: '24px' }}>Contributions</h1>

      {/* Pending account notice */}
      {account.status === 'pending' && (
        <div style={{
          background: colors.pendingBg,
          border: `1px solid ${colors.pendingBorder}`,
          borderRadius: '8px',
          padding: '12px 16px',
          fontSize: '13px',
          color: colors.pending,
          marginBottom: '16px',
        }}>
          Your account is under review. You can upload data now — contributed events will be held for review until your account is approved.
        </div>
      )}

      {/* Stats */}
      <div style={{
        display: 'flex',
        gap: '12px',
        marginBottom: '24px',
      }}>
        <div style={{
          ...styles.card,
          flex: 1,
          textAlign: 'center',
          padding: '16px',
        }}>
          <div style={{ fontSize: '24px', fontWeight: 600, color: colors.heading }}>
            {batches.length}
          </div>
          <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
            Upload{batches.length !== 1 ? 's' : ''}
          </div>
        </div>
        <div style={{
          ...styles.card,
          flex: 1,
          textAlign: 'center',
          padding: '16px',
        }}>
          <div style={{ fontSize: '24px', fontWeight: 600, color: colors.heading }}>
            {totalEvents}
          </div>
          <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
            Event{totalEvents !== 1 ? 's' : ''} Created
          </div>
        </div>
      </div>

      {/* Upload CTA */}
      <button
        type="button"
        className="btn-primary"
        style={{ ...styles.buttonPrimary, marginBottom: '24px' }}
        onClick={() => onNavigate('upload')}
      >
        Upload CSV
      </button>

      {/* Error */}
      {error && (
        <div style={{
          background: colors.errorBg,
          color: colors.error,
          border: `1px solid ${colors.errorBorder}`,
          padding: '10px 14px',
          borderRadius: '8px',
          fontSize: '14px',
          marginBottom: '16px',
        }}>
          {error}
        </div>
      )}

      {/* Batch list */}
      {loading ? (
        <div style={{ fontSize: '14px', color: colors.muted, textAlign: 'center', padding: '32px 0' }}>
          Loading...
        </div>
      ) : batches.length === 0 ? (
        <div style={{
          ...styles.card,
          textAlign: 'center',
          padding: '40px 20px',
          color: colors.muted,
        }}>
          <div style={{ fontSize: '14px', marginBottom: '8px' }}>No contributions yet</div>
          <div style={{ fontSize: '13px', color: colors.dim }}>
            Upload a CSV to contribute event data to the Commons.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {batches.map(batch => (
            <BatchCard key={batch.id} batch={batch} />
          ))}
        </div>
      )}

      {/* Secondary link to events */}
      {totalEvents > 0 && (
        <div style={{ marginTop: '24px', textAlign: 'center' }}>
          <button
            type="button"
            onClick={() => onNavigate('events')}
            style={{
              background: 'none',
              border: 'none',
              color: colors.muted,
              fontSize: '13px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              textDecoration: 'underline',
            }}
          >
            View all contributed events
          </button>
        </div>
      )}
    </>
  );
}

// =============================================================================
// BATCH CARD
// =============================================================================

function BatchCard({ batch }: { batch: ContributionBatch }) {
  const statusConfig = STATUS_CONFIG[batch.status] || STATUS_CONFIG.draft!;

  return (
    <div style={{
      background: colors.card,
      border: `1px solid ${colors.border}`,
      borderRadius: '10px',
      padding: '14px 16px',
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '6px',
      }}>
        <div style={{ fontSize: '14px', fontWeight: 500, color: colors.heading }}>
          {batch.file_name || 'Unnamed upload'}
        </div>
        <span style={{
          fontSize: '10px',
          padding: '1px 8px',
          borderRadius: '10px',
          color: statusConfig.color,
          background: statusConfig.bg,
          border: `1px solid ${statusConfig.border}`,
        }}>
          {statusConfig.label}
        </span>
      </div>

      <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: colors.muted }}>
        <span>{batch.total_rows} row{batch.total_rows !== 1 ? 's' : ''}</span>
        {batch.created_events > 0 && (
          <span>{batch.created_events} event{batch.created_events !== 1 ? 's' : ''} created</span>
        )}
        {batch.error_rows > 0 && (
          <span style={{ color: colors.error }}>{batch.error_rows} error{batch.error_rows !== 1 ? 's' : ''}</span>
        )}
        <span>{formatDate(batch.created_at)}</span>
      </div>
    </div>
  );
}
