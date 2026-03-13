import { styles, colors } from '../lib/styles';
import { EVENT_TAGS, AGE_TAGS, getTagsForCategory, type EventTag } from '../lib/tags';

interface TagPickerProps {
  category: string;
  value: string[];
  onChange: (tags: string[]) => void;
}

export function TagPicker({ category, value, onChange }: TagPickerProps) {
  const availableTags = getTagsForCategory(category);

  if (availableTags.length === 0) return null;

  const ageSlugs = AGE_TAGS as string[];
  const ageTags = availableTags.filter((t) => ageSlugs.includes(t));
  const otherTags = availableTags.filter((t) => !ageSlugs.includes(t));

  function toggleTag(tag: string) {
    if (ageSlugs.includes(tag)) {
      // Age tags are mutually exclusive (radio behavior)
      if (value.includes(tag)) {
        onChange(value.filter((t) => t !== tag));
      } else {
        onChange([...value.filter((t) => !ageSlugs.includes(t)), tag]);
      }
    } else {
      if (value.includes(tag)) {
        onChange(value.filter((t) => t !== tag));
      } else {
        onChange([...value, tag]);
      }
    }
  }

  return (
    <div>
      {ageTags.length > 0 && (
        <div style={{ marginBottom: '8px' }}>
          <div style={{ fontSize: '11px', color: colors.dim, marginBottom: '4px' }}>Age restriction (pick one)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {ageTags.map((tag) => {
              const active = value.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  style={{
                    ...styles.pill,
                    ...(active ? styles.pillActive : styles.pillInactive),
                  }}
                  onClick={() => toggleTag(tag)}
                >
                  {EVENT_TAGS[tag as EventTag].label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {otherTags.map((tag) => {
          const active = value.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              style={{
                ...styles.pill,
                ...(active ? styles.pillActive : styles.pillInactive),
              }}
              onClick={() => toggleTag(tag)}
            >
              {EVENT_TAGS[tag as EventTag].label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
