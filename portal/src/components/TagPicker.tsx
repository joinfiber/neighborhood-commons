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

  const selectedAge = value.find((t) => ageSlugs.includes(t)) || null;

  function selectAge(tag: string | null) {
    const without = value.filter((t) => !ageSlugs.includes(t));
    onChange(tag ? [...without, tag] : without);
  }

  function toggleTag(tag: string) {
    if (value.includes(tag)) {
      onChange(value.filter((t) => t !== tag));
    } else {
      onChange([...value, tag]);
    }
  }

  return (
    <div>
      {/* Age restriction — radio buttons, only when multiple options */}
      {ageTags.length > 1 && (
        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '11px', color: colors.dim, marginBottom: '6px' }}>
            Age restriction
          </div>
          <div style={{ display: 'flex', gap: '16px' }}>
            {ageTags.map((tag) => (
              <label key={tag} style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="age-restriction"
                  checked={selectedAge === tag}
                  onChange={() => selectAge(tag)}
                  style={{ accentColor: colors.accent }}
                />
                <span style={{ fontSize: '13px', color: colors.text }}>
                  {EVENT_TAGS[tag as EventTag].label}
                </span>
              </label>
            ))}
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="radio"
                name="age-restriction"
                checked={!selectedAge}
                onChange={() => selectAge(null)}
                style={{ accentColor: colors.accent }}
              />
              <span style={{ fontSize: '13px', color: colors.dim }}>Not specified</span>
            </label>
          </div>
        </div>
      )}

      {/* Tags — multi-select pills */}
      {otherTags.length > 0 && (
        <div>
          <div style={{ fontSize: '11px', color: colors.dim, marginBottom: '6px' }}>
            Select all that apply
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {otherTags.map((tag) => {
              const active = value.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  style={{
                    ...styles.pill,
                    ...(active ? {
                      background: colors.accent,
                      color: '#ffffff',
                      borderColor: colors.accent,
                    } : styles.pillInactive),
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
    </div>
  );
}
