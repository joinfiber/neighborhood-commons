import { PORTAL_CATEGORIES, PORTAL_CATEGORY_KEYS, type PortalCategory } from '../lib/categories';
import { styles } from '../lib/styles';

interface CategoryPickerProps {
  value: string;
  onChange: (category: string) => void;
}

export function CategoryPicker({ value, onChange }: CategoryPickerProps) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
      {PORTAL_CATEGORY_KEYS.map((key: PortalCategory) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            style={{
              ...styles.pill,
              ...(active ? styles.pillActive : styles.pillInactive),
            }}
            onClick={() => onChange(key)}
          >
            {PORTAL_CATEGORIES[key].label}
          </button>
        );
      })}
    </div>
  );
}
