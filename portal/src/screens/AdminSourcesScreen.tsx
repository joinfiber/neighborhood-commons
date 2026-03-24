import { useState } from 'react';
import { colors, radii } from '../lib/styles';
import { AdminNewsletterSourcesScreen } from './AdminNewsletterSourcesScreen';
import { AdminFeedSourcesScreen } from './AdminFeedSourcesScreen';

type Tab = 'feeds' | 'newsletters';

interface Props {
  onNavigate: (hash: string) => void;
}

export function AdminSourcesScreen({ onNavigate }: Props) {
  const [tab, setTab] = useState<Tab>('feeds');

  return (
    <div>
      <div style={{ display: 'flex', gap: '4px', marginBottom: '20px' }}>
        {([
          { key: 'feeds' as Tab, label: 'Feed Sources' },
          { key: 'newsletters' as Tab, label: 'Newsletters' },
        ]).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            style={{
              padding: '7px 16px',
              fontSize: '13px',
              fontWeight: tab === t.key ? 600 : 400,
              borderRadius: radii.pill,
              border: `1px solid ${tab === t.key ? colors.accent : colors.border}`,
              background: tab === t.key ? colors.accentDim : 'transparent',
              color: tab === t.key ? colors.accent : colors.muted,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'feeds' && <AdminFeedSourcesScreen />}
      {tab === 'newsletters' && <AdminNewsletterSourcesScreen onNavigate={onNavigate} />}
    </div>
  );
}
