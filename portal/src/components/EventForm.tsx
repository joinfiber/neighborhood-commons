import { useState } from 'react';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { styles, colors, categoryColors, spacing, radii } from '../lib/styles';
import type { EventFormData, PlaceResult } from '../lib/types';
import { PORTAL_CATEGORIES, PORTAL_CATEGORY_KEYS } from '../lib/categories';
import { CalendarPicker } from './CalendarPicker';
import { TimePicker } from './TimePicker';
import { RecurrencePicker } from './RecurrencePicker';
import { PlaceAutocomplete } from './PlaceAutocomplete';
import { ImageUpload } from './ImageUpload';
import { ImageCropPreview } from './ImageCropPreview';
import { TagPicker } from './TagPicker';
import { Tooltip } from './Tooltip';
import { getTagsForCategory, AGE_TAGS } from '../lib/tags';

// ---------------------------------------------------------------------------
// Tooltip content
// ---------------------------------------------------------------------------

const TIPS = {
  endTime: 'Adding an end time helps people plan their evening and lets apps show duration. Leave blank if the event winds down naturally.',
  recurrence: 'Recurring events post once and repeat on your schedule. You can always edit individual dates later.',
  venue: 'Search for your venue to auto-fill the address and map pin. This helps people find your event in location-based apps.',
  category: 'Choose the category that best describes the experience. This is how people filter and discover your event.',
  tags: 'Tags describe the experience — what to expect when you show up. Select all that apply.',
  image: 'A photo makes your event stand out in feeds and cards. Avoid images with text — they get cropped differently by every app.',
  description: 'A few sentences about what to expect. Keep it conversational — this shows up in event listings and search results.',
  price: 'A quick note about cost. Free is worth saying — it\'s a strong draw.',
  link: 'A link to tickets, registration, or more info. We\'ll add https:// if you skip it.',
} as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface EventFormProps {
  mode: 'create' | 'edit' | 'admin-create';
  initialValues?: Partial<EventFormData>;
  hasExistingImage?: boolean;
  onSubmit: (data: EventFormData) => Promise<{ error?: string } | void>;
  searchCoords?: { latitude: number; longitude: number };
  submitting?: boolean;
  submitLabel?: string;
  accountWheelchairAccessible?: boolean | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EventForm({
  mode,
  initialValues = {},
  hasExistingImage: initialHasExistingImage = false,
  onSubmit,
  searchCoords,
  submitting = false,
  submitLabel,
  accountWheelchairAccessible,
}: EventFormProps) {
  // ── State ──────────────────────────────────────────────────────────────

  const [title, setTitle] = useState(initialValues.title || '');
  const [venueName, setVenueName] = useState(initialValues.venue_name || '');
  const [address, setAddress] = useState(initialValues.address || '');
  const [placeId, setPlaceId] = useState(initialValues.place_id || '');
  const [latitude, setLatitude] = useState<number | undefined>(initialValues.latitude);
  const [longitude, setLongitude] = useState<number | undefined>(initialValues.longitude);
  const [eventDate, setEventDate] = useState(initialValues.event_date || '');
  const [startTime, setStartTime] = useState(initialValues.start_time || '19:00');
  const [endTime, setEndTime] = useState(initialValues.end_time || '');
  const [category, setCategory] = useState(initialValues.category || '');
  const [customCategory, setCustomCategory] = useState(initialValues.custom_category || '');
  const [recurrence, setRecurrence] = useState(initialValues.recurrence || 'none');
  const [instanceCount, setInstanceCount] = useState(initialValues.instance_count || 4);
  const [tags, setTags] = useState<string[]>(initialValues.tags || []);
  const [description, setDescription] = useState(initialValues.description || '');
  const [price, setPrice] = useState(initialValues.price || '');
  const [ticketUrl, setTicketUrl] = useState(initialValues.ticket_url || '');

  const [hasExistingImage, setHasExistingImage] = useState(initialHasExistingImage);
  const [image, setImage] = useState<string | null>(initialValues.image || null);
  const [imageFocalY, setImageFocalY] = useState(initialValues.image_focal_y ?? 0.5);

  const [linkError, setLinkError] = useState('');
  const [error, setError] = useState<string | null>(null);

  const hasPrefilledVenue = !!(initialValues.venue_name && mode !== 'edit');
  const [editingVenue, setEditingVenue] = useState(!hasPrefilledVenue);

  const { isMobile } = useBreakpoint();

  // ── Handlers ───────────────────────────────────────────────────────────

  function handleCategoryChange(newCategory: string) {
    setCategory(newCategory);
    const allowed = getTagsForCategory(newCategory) as string[];
    const ageSlugs = AGE_TAGS as string[];
    setTags((prev) => {
      const filtered = prev.filter((t) => allowed.includes(t));
      const ageOptions = allowed.filter((t) => ageSlugs.includes(t));
      const singleAge = ageOptions.length === 1 ? ageOptions[0] : undefined;
      if (singleAge && !filtered.some((t) => ageSlugs.includes(t))) {
        return [...filtered, singleAge];
      }
      return filtered;
    });
  }

  function handlePlaceSelect(place: PlaceResult) {
    setVenueName(place.name);
    setAddress(place.address || '');
    setPlaceId(place.place_id);
    setLatitude(place.location?.latitude);
    setLongitude(place.location?.longitude);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title || !venueName || !eventDate || !startTime || !category) return;
    setError(null);

    const data: EventFormData = {
      title,
      venue_name: venueName,
      event_date: eventDate,
      start_time: startTime,
      category,
      recurrence,
      address: address || undefined,
      place_id: placeId || undefined,
      latitude,
      longitude,
      end_time: endTime || undefined,
      custom_category: category === 'other' ? customCategory || undefined : undefined,
      instance_count: recurrence !== 'none' ? instanceCount : undefined,
      start_time_required: true,
      tags: tags.length > 0 ? tags : undefined,
      wheelchair_accessible: accountWheelchairAccessible ?? null,
      rsvp_limit: null,
      description: description || undefined,
      price: price || undefined,
      ticket_url: ticketUrl ? normalizeUrl(ticketUrl) || undefined : undefined,
      image: image || null,
      image_focal_y: imageFocalY,
    };

    try {
      const result = await onSubmit(data);
      if (result?.error) setError(result.error);
    } catch {
      setError('Something went wrong. Please try again.');
    }
  }

  const label = submitLabel || (mode === 'edit' ? 'Save Changes' : 'Post Event');
  const isValid = !!(title && venueName && eventDate && startTime && category);
  const hasAvailableTags = !!category && getTagsForCategory(category).length > 0;
  const repeats = recurrence !== 'none';
  const catColor = category ? categoryColors[category] : null;

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <>
      {/* Error banner */}
      {error && (
        <div style={{
          background: colors.errorBg,
          color: colors.error,
          padding: '10px 14px',
          borderRadius: radii.md,
          fontSize: '14px',
          marginBottom: spacing.md,
          border: `1px solid ${colors.errorBorder}`,
        }}>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ maxWidth: '680px', width: '100%' }}>

        {/* ═══════════════════════════════════════════════════════════════════
            ESSENTIALS — what, when, where, what kind
            ═══════════════════════════════════════════════════════════════════ */}

        {/* Title */}
        <div style={{ marginBottom: spacing.xl }}>
          <label style={styles.srOnly}>Event name</label>
          <input
            className="title-input"
            style={styles.titleInput}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Event name"
            required
          />
        </div>

        {/* Date + Start Time */}
        <div style={styles.fieldGroup}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
            gap: spacing.md,
          }}>
            <div>
              <label style={styles.formLabel}>Date</label>
              <CalendarPicker value={eventDate} onChange={setEventDate} />
            </div>
            <div>
              <label style={styles.formLabel}>Start time</label>
              <TimePicker value={startTime || '19:00'} onChange={setStartTime} />
            </div>
          </div>
        </div>

        {/* End Time */}
        <div style={styles.fieldGroup}>
          <label style={styles.formLabel}>
            End time{' '}
            <span style={styles.optionalLabel}>(optional)</span>
            <Tooltip id="tip-end-time" content={TIPS.endTime} />
          </label>
          {endTime ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ flex: 1 }}>
                <TimePicker value={endTime} onChange={setEndTime} />
              </div>
              <button
                type="button"
                onClick={() => setEndTime('')}
                aria-label="Remove end time"
                style={{
                  background: 'none',
                  border: 'none',
                  color: colors.dim,
                  cursor: 'pointer',
                  fontSize: '18px',
                  padding: '4px 8px',
                  lineHeight: 1,
                  borderRadius: radii.sm,
                  transition: 'color 0.15s',
                }}
              >
                ×
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEndTime('21:00')}
              style={{
                ...styles.input,
                color: colors.dim,
                cursor: 'pointer',
                textAlign: 'left' as const,
              }}
            >
              Set end time
            </button>
          )}
        </div>

        {/* Recurrence */}
        <div style={styles.fieldGroup}>
          <label style={styles.formLabel}>
            Repeats
            <Tooltip id="tip-recurrence" content={TIPS.recurrence} />
          </label>
          <div style={{ display: 'flex', gap: '8px', marginBottom: repeats ? spacing.md : 0 }}>
            <button
              type="button"
              style={{ ...styles.pill, ...(repeats ? styles.pillInactive : styles.pillActive) }}
              onClick={() => setRecurrence('none')}
            >
              One-time
            </button>
            <button
              type="button"
              style={{ ...styles.pill, ...(repeats ? styles.pillActive : styles.pillInactive) }}
              onClick={() => { if (!repeats) { setRecurrence('weekly'); setInstanceCount(4); } }}
            >
              Repeats
            </button>
          </div>
          {repeats && (
            <RecurrencePicker
              value={recurrence}
              onChange={setRecurrence}
              eventDate={eventDate}
              instanceCount={instanceCount}
              onInstanceCountChange={setInstanceCount}
            />
          )}
        </div>

        {/* Venue */}
        <div style={styles.fieldGroup}>
          <label style={styles.formLabel}>
            Venue
            <Tooltip id="tip-venue" content={TIPS.venue} />
          </label>
          {!editingVenue && venueName ? (
            <div style={{
              background: colors.bg,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              padding: '12px 14px',
            }}>
              <div style={{ fontSize: '15px', fontWeight: 500, color: colors.text }}>
                {venueName}
              </div>
              {address && (
                <div style={{ fontSize: '13px', color: colors.muted, marginTop: '2px' }}>
                  {address}
                </div>
              )}
              <button
                type="button"
                onClick={() => setEditingVenue(true)}
                style={{ ...styles.buttonText, padding: '2px 0', marginTop: '6px', fontSize: '12px' }}
              >
                Change venue
              </button>
            </div>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
              gap: '10px',
            }}>
              <PlaceAutocomplete
                value={venueName}
                onChange={setVenueName}
                onSelect={handlePlaceSelect}
                placeholder="Venue name"
                searchCoords={searchCoords}
              />
              <input
                style={styles.input}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={mode === 'create' ? 'Auto-fills from venue' : 'Address'}
              />
            </div>
          )}
        </div>

        {/* Category */}
        <div style={styles.fieldGroup}>
          <label style={styles.formLabel}>
            Category
            <Tooltip id="tip-category" content={TIPS.category} />
          </label>
          <select
            style={{
              ...styles.select,
              fontFamily: 'inherit',
              ...(catColor ? {
                borderColor: catColor.fg + '30',
                backgroundColor: catColor.bg,
                color: catColor.fg,
                fontWeight: 500,
              } : {}),
            }}
            value={category}
            onChange={(e) => handleCategoryChange(e.target.value)}
            required
          >
            <option value="">Choose a category...</option>
            {PORTAL_CATEGORY_KEYS.map((key) => (
              <option key={key} value={key}>
                {PORTAL_CATEGORIES[key].label}
              </option>
            ))}
          </select>

          {category === 'other' && (
            <div style={{ marginTop: '10px' }}>
              <label style={styles.formLabel}>Custom category</label>
              <input
                style={styles.input}
                value={customCategory}
                onChange={(e) => setCustomCategory(e.target.value)}
                placeholder="e.g., Book club"
                maxLength={50}
              />
            </div>
          )}
        </div>

        {/* Tags */}
        <div style={styles.fieldGroup}>
          <label style={styles.formLabel}>
            Tags{' '}
            <span style={styles.optionalLabel}>(optional)</span>
            <Tooltip id="tip-tags" content={TIPS.tags} />
          </label>
          {hasAvailableTags ? (
            <TagPicker category={category} value={tags} onChange={setTags} />
          ) : (
            <div style={{ fontSize: '13px', color: colors.dim, padding: '8px 0' }}>
              {category
                ? 'No tags available for this category.'
                : 'Select a category first to see available tags.'}
            </div>
          )}
        </div>

        {/* ═══════════════════════════════════════════════════════════════════
            DIVIDER
            ═══════════════════════════════════════════════════════════════════ */}

        <hr style={styles.fieldDivider} />

        {/* ═══════════════════════════════════════════════════════════════════
            ENRICHMENT — image, description, price, link
            ═══════════════════════════════════════════════════════════════════ */}

        {/* Image */}
        <div style={styles.fieldGroup}>
          <label style={styles.formLabel}>
            Photo{' '}
            <span style={styles.optionalLabel}>(optional)</span>
            <Tooltip id="tip-image" content={TIPS.image} />
          </label>
          {mode === 'edit' && hasExistingImage && !image && (
            <div style={{
              background: colors.bg,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              padding: '12px',
              marginBottom: '8px',
              fontSize: '12px',
              color: colors.muted,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <span>Current image attached</span>
              <button
                type="button"
                className="btn-text"
                style={{ ...styles.buttonText, color: colors.error }}
                onClick={() => setHasExistingImage(false)}
                aria-label="Remove current image"
              >
                Remove
              </button>
            </div>
          )}
          <ImageUpload value={image} onChange={setImage} />
          {image && (
            <ImageCropPreview
              imageSrc={image}
              focalY={imageFocalY}
              onFocalYChange={setImageFocalY}
            />
          )}
        </div>

        {/* Description */}
        <div style={styles.fieldGroup}>
          <label style={styles.formLabel}>
            Description{' '}
            <span style={styles.optionalLabel}>(optional)</span>
            <Tooltip id="tip-description" content={TIPS.description} />
          </label>
          <textarea
            style={{ ...styles.textarea, minHeight: '120px' }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What should people know about this event?"
          />
        </div>

        {/* Price + Link */}
        <div style={styles.fieldGroup}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
            gap: spacing.md,
          }}>
            <div>
              <label style={styles.formLabel}>
                Price{' '}
                <span style={styles.optionalLabel}>(optional)</span>
                <Tooltip id="tip-price" content={TIPS.price} />
              </label>
              <input
                style={styles.input}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="Free, $10, $5–15..."
              />
            </div>
            <div>
              <label style={styles.formLabel}>
                Link{' '}
                <span style={styles.optionalLabel}>(optional)</span>
                <Tooltip id="tip-link" content={TIPS.link} />
              </label>
              <input
                style={{
                  ...styles.input,
                  ...(linkError ? { borderColor: colors.error, boxShadow: `0 0 0 3px ${colors.error}10` } : {}),
                }}
                value={ticketUrl}
                onChange={(e) => { setTicketUrl(e.target.value); setLinkError(''); }}
                onBlur={() => {
                  if (!ticketUrl.trim()) { setLinkError(''); return; }
                  const normalized = normalizeUrl(ticketUrl);
                  if (normalized !== ticketUrl) setTicketUrl(normalized);
                  if (!isValidUrl(normalized)) {
                    setLinkError('Enter a URL like eventbrite.com/your-event');
                  }
                }}
                placeholder="eventbrite.com/your-event"
                inputMode="url"
              />
              {linkError && (
                <div style={{ fontSize: '12px', color: colors.error, marginTop: '4px' }}>
                  {linkError}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ═══════════════════════════════════════════════════════════════════
            SUBMIT
            ═══════════════════════════════════════════════════════════════════ */}

        <div style={isMobile ? styles.stickySubmit : { marginTop: spacing.xl }}>
          <button
            type="submit"
            className="btn-primary"
            style={styles.buttonPrimary}
            disabled={submitting || !isValid}
          >
            {submitting ? (mode === 'edit' ? 'Saving...' : 'Posting...') : label}
          </button>
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('.');
  } catch {
    return false;
  }
}
