import { useState, useEffect } from 'react';
import { colors, radii, spacing } from '../lib/styles';
import { adminFetchAudit } from '../lib/api';
import type { DataAudit } from '../lib/types';
import { CategoryDistribution } from '../components/CategoryDistribution';

function pct(n: number, total: number): string {
  if (total === 0) return '—';
  return `${Math.round((n / total) * 100)}%`;
}

function QualityRow({ label, count, total, good }: { label: string; count: number; total: number; good?: boolean }) {
  const ratio = total > 0 ? count / total : 0;
  const color = good ? colors.success : ratio > 0.3 ? colors.error : ratio > 0.1 ? colors.pending : colors.success;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${colors.border}` }}>
      <span style={{ fontSize: '13px', color: colors.muted }}>{label}</span>
      <span className="tnum" style={{ fontSize: '13px', fontWeight: 600, color }}>{count} <span style={{ fontWeight: 400, color: colors.dim }}>({pct(count, total)})</span></span>
    </div>
  );
}

function DistributionBar({ data, total }: { data: Record<string, number>; total: number }) {
  const sorted = Object.entries(data).sort(([, a], [, b]) => b - a);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      {sorted.map(([key, count]) => {
        const width = total > 0 ? Math.max(2, (count / total) * 100) : 0;
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '100px', fontSize: '12px', color: colors.muted, textAlign: 'right', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {key}
            </div>
            <div style={{ flex: 1, height: '16px', background: colors.bg, borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ width: `${width}%`, height: '100%', background: colors.accent, borderRadius: '3px', transition: 'width 0.3s' }} />
            </div>
            <span className="tnum" style={{ fontSize: '12px', color: colors.dim, width: '40px', textAlign: 'right', flexShrink: 0 }}>{count}</span>
          </div>
        );
      })}
    </div>
  );
}

export function AdminPulseScreen() {
  const [audit, setAudit] = useState<DataAudit | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await adminFetchAudit();
      if (res.data?.audit) setAudit(res.data.audit);
      else if (res.error) setError(res.error.message);
      setLoading(false);
    })();
  }, []);

  if (loading) return <div style={{ color: colors.dim, fontSize: '14px', padding: '40px 0' }}>Running audit...</div>;
  if (error) return <div style={{ color: colors.error, fontSize: '14px' }}>{error}</div>;
  if (!audit) return null;

  const q = audit.quality;
  const total = audit.unique_events;

  return (
    <div style={{ maxWidth: '700px' }}>
      <h2 style={{ margin: '0 0 20px', fontSize: '20px', fontWeight: 600 }}>Pulse</h2>

      {/* Hero: Category distribution */}
      <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: radii.md, padding: '16px', marginBottom: spacing.lg }}>
        <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.dim, marginBottom: '10px' }}>
          Categories
        </div>
        <CategoryDistribution data={audit.distributions.category} total={total} />
      </div>

      {/* Top-line numbers */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: spacing.lg, flexWrap: 'wrap' }}>
        {[
          { label: 'Total Rows', value: audit.total_rows },
          { label: 'Unique Events', value: audit.unique_events },
          { label: 'Series', value: audit.series_count },
          { label: 'One-Offs', value: audit.one_off_count },
          { label: 'Upcoming', value: audit.upcoming },
          { label: 'Past', value: audit.past },
        ].map((s) => (
          <div key={s.label} style={{
            flex: '1 1 90px', background: colors.card, border: `1px solid ${colors.border}`,
            borderRadius: radii.md, padding: '10px 12px', textAlign: 'center', minWidth: '70px',
          }}>
            <div className="tnum" style={{ fontSize: '20px', fontWeight: 600, color: colors.heading }}>{s.value}</div>
            <div style={{ fontSize: '10px', color: colors.dim, marginTop: '2px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Quality flags */}
      <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: radii.md, padding: '16px', marginBottom: spacing.lg }}>
        <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.dim, marginBottom: '8px' }}>
          Quality ({total} unique events)
        </div>
        <QualityRow label="Missing venue name" count={q.missing_venue} total={total} />
        <QualityRow label="Missing date" count={q.missing_date} total={total} />
        <QualityRow label="Missing title" count={q.missing_title} total={total} />
        <QualityRow label="No description" count={q.no_description} total={total} />
        <QualityRow label="No creator account" count={q.no_account} total={total} />
        <QualityRow label="No coordinates" count={q.no_coordinates} total={total} />
        <QualityRow label="No image" count={q.no_image} total={total} />
        <QualityRow label="No price info" count={q.no_price} total={total} />
      </div>

      {/* Source distribution */}
      <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: radii.md, padding: '16px', marginBottom: spacing.lg }}>
        <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.dim, marginBottom: '10px' }}>
          Sources
        </div>
        <DistributionBar data={audit.distributions.source_method} total={total} />
      </div>

      {/* Status distribution */}
      <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: radii.md, padding: '16px', marginBottom: spacing.lg }}>
        <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.dim, marginBottom: '10px' }}>
          Status
        </div>
        <DistributionBar data={audit.distributions.status} total={total} />
      </div>

      {/* Community events sample */}
      {audit.samples.community_events.length > 0 && (
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: radii.md, padding: '16px', marginBottom: spacing.lg }}>
          <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.dim, marginBottom: '10px' }}>
            "Community" category (may need reclassification) — {audit.samples.community_events.length} shown
          </div>
          {audit.samples.community_events.map((e) => (
            <div key={e.id} style={{ fontSize: '13px', color: colors.muted, padding: '4px 0', borderBottom: `1px solid ${colors.border}` }}>
              <span style={{ color: colors.heading }}>{e.title}</span>
              <span style={{ fontSize: '11px', marginLeft: '8px' }}>via {e.source_method}</span>
            </div>
          ))}
        </div>
      )}

      {/* Orphaned events sample */}
      {audit.samples.orphaned.length > 0 && (
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: radii.md, padding: '16px', marginBottom: spacing.lg }}>
          <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.error, marginBottom: '10px' }}>
            No creator account — {audit.samples.orphaned.length} shown
          </div>
          {audit.samples.orphaned.map((e) => (
            <div key={e.id} style={{ fontSize: '13px', color: colors.muted, padding: '4px 0', borderBottom: `1px solid ${colors.border}` }}>
              <span style={{ color: colors.heading }}>{e.title}</span>
              <span style={{ fontSize: '11px', marginLeft: '8px' }}>source: {e.source} / {e.source_method}</span>
            </div>
          ))}
        </div>
      )}

      {/* Missing venue sample */}
      {audit.samples.missing_venue.length > 0 && (
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: radii.md, padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.pending, marginBottom: '10px' }}>
            Missing venue — {audit.samples.missing_venue.length} shown
          </div>
          {audit.samples.missing_venue.map((e) => (
            <div key={e.id} style={{ fontSize: '13px', color: colors.muted, padding: '4px 0', borderBottom: `1px solid ${colors.border}` }}>
              <span style={{ color: colors.heading }}>{e.title}</span>
              <span style={{ fontSize: '11px', marginLeft: '8px' }}>via {e.source_method}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
