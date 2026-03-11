import { colors } from '../lib/styles';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  radius?: string | number;
  block?: boolean;
}

export function Skeleton({ width, height = 16, radius = 6, block }: SkeletonProps) {
  return (
    <div
      className="skeleton"
      style={{
        width: block ? '100%' : (typeof width === 'number' ? `${width}px` : width),
        height: typeof height === 'number' ? `${height}px` : height,
        borderRadius: typeof radius === 'number' ? `${radius}px` : radius,
      }}
    />
  );
}

export function EventRowSkeleton() {
  return (
    <div style={{
      background: colors.card,
      border: `1px solid ${colors.border}`,
      borderRadius: '10px',
      padding: '14px 16px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    }}>
      <div>
        <Skeleton width={180} height={14} />
        <div style={{ marginTop: 6 }}>
          <Skeleton width={260} height={12} />
        </div>
      </div>
      <Skeleton width={60} height={20} radius={16} />
    </div>
  );
}

export function StatCardSkeleton() {
  return (
    <div style={{
      background: colors.card,
      border: `1px solid ${colors.border}`,
      borderRadius: '10px',
      padding: '16px',
      textAlign: 'center',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 6,
    }}>
      <Skeleton width={40} height={28} />
      <Skeleton width={60} height={11} />
    </div>
  );
}

export function AccountInfoSkeleton() {
  return (
    <div style={{
      background: colors.card,
      border: `1px solid ${colors.border}`,
      borderRadius: '14px',
      padding: '24px',
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}>
            <Skeleton width={60} height={11} />
            <div style={{ marginTop: 4 }}>
              <Skeleton width={140} height={14} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
