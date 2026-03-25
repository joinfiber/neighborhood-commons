import { colors } from '../lib/styles';
import { PORTAL_CATEGORIES, type PortalCategory } from '../lib/categories';

interface Props {
  data: Record<string, number>;
  total: number;
  compact?: boolean;
}

function catLabel(key: string): string {
  return PORTAL_CATEGORIES[key as PortalCategory]?.label || key;
}

function catColor(key: string): string {
  return PORTAL_CATEGORIES[key as PortalCategory]?.color || colors.dim;
}

/**
 * Category distribution visualization.
 *
 * compact=true: single segmented horizontal bar (for embedding in stats bars).
 * compact=false (default): vertical list with bars and counts.
 */
export function CategoryDistribution({ data, total, compact }: Props) {
  const sorted = Object.entries(data).sort(([, a], [, b]) => b - a);

  if (sorted.length === 0) {
    return <span style={{ fontSize: '12px', color: colors.dim }}>No category data</span>;
  }

  // ── Compact: single segmented bar ──────────────────────────────
  if (compact) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ display: 'flex', height: '14px', borderRadius: '7px', overflow: 'hidden', background: colors.bg }}>
          {sorted.map(([key, count]) => {
            const pct = total > 0 ? (count / total) * 100 : 0;
            if (pct < 1) return null;
            return (
              <div
                key={key}
                title={`${catLabel(key)}: ${count}`}
                style={{
                  width: `${pct}%`,
                  background: catColor(key),
                  minWidth: '3px',
                  transition: 'width 0.3s',
                }}
              />
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {sorted.slice(0, 6).map(([key, count]) => (
            <span key={key} style={{ fontSize: '10px', color: colors.dim, display: 'flex', alignItems: 'center', gap: '3px' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: catColor(key), flexShrink: 0 }} />
              <span className="tnum">{count}</span> {catLabel(key)}
            </span>
          ))}
          {sorted.length > 6 && (
            <span style={{ fontSize: '10px', color: colors.dim }}>+{sorted.length - 6} more</span>
          )}
        </div>
      </div>
    );
  }

  // ── Full: vertical bar list ────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      {sorted.map(([key, count]) => {
        const width = total > 0 ? Math.max(2, (count / total) * 100) : 0;
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              width: '110px', fontSize: '12px', color: colors.muted, textAlign: 'right',
              flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {catLabel(key)}
            </div>
            <div style={{ flex: 1, height: '16px', background: colors.bg, borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{
                width: `${width}%`, height: '100%', background: catColor(key),
                borderRadius: '3px', transition: 'width 0.3s',
              }} />
            </div>
            <span className="tnum" style={{ fontSize: '12px', color: colors.dim, width: '36px', textAlign: 'right', flexShrink: 0 }}>
              {count}
            </span>
          </div>
        );
      })}
    </div>
  );
}
