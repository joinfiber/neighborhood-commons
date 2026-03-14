import { useState } from 'react';
import { styles, colors } from '../lib/styles';
import type { EventFormData, PlaceResult } from '../lib/types';
import { PORTAL_CATEGORIES, PORTAL_CATEGORY_KEYS } from '../lib/categories';
import { CalendarPicker } from './CalendarPicker';
import { TimePicker } from './TimePicker';
import { RecurrencePicker } from './RecurrencePicker';
import { PlaceAutocomplete } from './PlaceAutocomplete';
import { ImageUpload } from './ImageUpload';
import { ImageCropPreview } from './ImageCropPreview';
import { EventPreviews } from './EventPreviews';
import { TagPicker } from './TagPicker';
import { getTagsForCategory } from '../lib/tags';

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
  const [startTimeRequired, setStartTimeRequired] = useState(initialValues.start_time_required ?? true);
  const [tags, setTags] = useState<string[]>(initialValues.tags || []);
  const [wheelchairAccessible, setWheelchairAccessible] = useState<boolean | null>(
    initialValues.wheelchair_accessible ?? accountWheelchairAccessible ?? null,
  );
  const [description, setDescription] = useState(initialValues.description || '');
  const [price, setPrice] = useState(initialValues.price || '');
  const [ticketUrl, setTicketUrl] = useState(initialValues.ticket_url || '');

  const [hasExistingImage, setHasExistingImage] = useState(initialHasExistingImage);
  const [image, setImage] = useState<string | null>(initialValues.image || null);
  const [imageFocalY, setImageFocalY] = useState(initialValues.image_focal_y ?? 0.5);

  const [error, setError] = useState<string | null>(null);

  // Expandable sections — start open if values already exist
  const [showTags, setShowTags] = useState(() => (initialValues.tags?.length ?? 0) > 0);
  const [showRecurrence, setShowRecurrence] = useState(() =>
    !!initialValues.recurrence && initialValues.recurrence !== 'none'
  );

  function handleCategoryChange(newCategory: string) {
    setCategory(newCategory);
    const allowed = getTagsForCategory(newCategory) as string[];
    setTags((prev) => prev.filter((t) => allowed.includes(t)));
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
      start_time_required: startTimeRequired,
      tags: tags.length > 0 ? tags : undefined,
      wheelchair_accessible: wheelchairAccessible,
      description: description || undefined,
      price: price || undefined,
      ticket_url: ticketUrl || undefined,
      image: image || null,
      image_focal_y: imageFocalY,
    };

    try {
      const result = await onSubmit(data);
      if (result?.error) {
        setError(result.error);
      }
    } catch {
      setError('Something went wrong. Please try again.');
    }
  }

  const label = submitLabel || (mode === 'edit' ? 'Save Changes' : 'Post Event');
  const isValid = !!(title && venueName && eventDate && startTime && category);

  const hasAvailableTags = !!category && getTagsForCategory(category).length > 0;
  const showExtrasRow = (!showTags && hasAvailableTags) || !showRecurrence;

  return (
    <>
      {error && (
        <div style={{
          background: '#fef2f2',
          color: colors.error,
          padding: '10px 14px',
          borderRadius: '8px',
          fontSize: '14px',
          marginBottom: '16px',
        }}>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div style={styles.card}>
          {/* ── Title ── */}
          <div style={{ marginBottom: '16px' }}>
            <input
              style={{
                ...styles.input,
                fontSize: '18px',
                fontWeight: 500,
                padding: '12px 14px',
              }}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What's happening?"
              required
            />
          </div>

          {/* ── Venue + Address ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
            <div>
              <label style={styles.formLabel}>Venue</label>
              <PlaceAutocomplete
                value={venueName}
                onChange={setVenueName}
                onSelect={handlePlaceSelect}
                placeholder="Venue name"
                searchCoords={searchCoords}
              />
            </div>
            <div>
              <label style={styles.formLabel}>Address</label>
              <input
                style={styles.input}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={mode === 'create' ? 'Auto-fills from venue' : undefined}
              />
            </div>
          </div>

          {/* ── Date ── */}
          <div style={{ marginBottom: '16px' }}>
            <label style={styles.formLabel}>Date</label>
            <CalendarPicker value={eventDate} onChange={setEventDate} />
          </div>

          {/* ── Times ── */}
          <div style={{ marginBottom: '16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div>
                <label style={styles.formLabel}>Start</label>
                <TimePicker value={startTime || '19:00'} onChange={setStartTime} />
              </div>
              <div>
                <label style={styles.formLabel}>End <span style={{ color: colors.dim, fontWeight: 400 }}>(optional)</span></label>
                {endTime ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <TimePicker value={endTime} onChange={setEndTime} />
                    <button
                      type="button"
                      onClick={() => setEndTime('')}
                      style={{ background: 'none', border: 'none', color: colors.dim, cursor: 'pointer', fontSize: '16px', padding: '4px', lineHeight: 1 }}
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEndTime('21:00')}
                    style={{ ...styles.input, color: colors.dim, cursor: 'pointer', textAlign: 'left' as const }}
                  >
                    + Add end time
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ── Category (dropdown) ── */}
          <div style={{ marginBottom: '16px' }}>
            <label style={styles.formLabel}>Category</label>
            <select
              style={{ ...styles.select, fontFamily: 'inherit' }}
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
          </div>

          {/* Custom category (only when "Other" is selected) */}
          {category === 'other' && (
            <div style={{ marginBottom: '16px' }}>
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

          {/* ── Description ── */}
          <div style={{ marginBottom: '16px' }}>
            <label style={styles.formLabel}>Description</label>
            <textarea
              style={styles.textarea}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Tell people about this event..."
            />
          </div>

          {/* ── Price + Link ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
            <div>
              <label style={styles.formLabel}>Price</label>
              <input
                style={styles.input}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="Free, $10, etc."
              />
            </div>
            <div>
              <label style={styles.formLabel}>Link</label>
              <input
                style={styles.input}
                value={ticketUrl}
                onChange={(e) => setTicketUrl(e.target.value)}
                placeholder="https://..."
              />
            </div>
          </div>

          <hr style={styles.divider} />

          {/* ── Expand links for optional sections ── */}
          {showExtrasRow && (
            <div style={{ display: 'flex', gap: '16px', marginTop: '12px', marginBottom: '12px' }}>
              {!showTags && hasAvailableTags && (
                <button
                  type="button"
                  onClick={() => setShowTags(true)}
                  style={expandLinkStyle}
                >
                  + Add tags
                </button>
              )}
              {!showRecurrence && (
                <button
                  type="button"
                  onClick={() => {
                    setShowRecurrence(true);
                    if (recurrence === 'none') {
                      setRecurrence('weekly');
                      setInstanceCount(4);
                    }
                  }}
                  style={expandLinkStyle}
                >
                  + Make recurring
                </button>
              )}
            </div>
          )}

          {/* Tags (expanded) */}
          {showTags && category && (
            <div style={{ marginBottom: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <label style={{ ...styles.formLabel, marginBottom: 0 }}>Tags</label>
                <button
                  type="button"
                  onClick={() => { setShowTags(false); setTags([]); }}
                  style={collapseLinkStyle}
                >
                  Remove
                </button>
              </div>
              <TagPicker category={category} value={tags} onChange={setTags} />
            </div>
          )}

          {/* Recurrence (expanded) */}
          {showRecurrence && (
            <div style={{ marginBottom: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <label style={{ ...styles.formLabel, marginBottom: 0 }}>Recurrence</label>
                <button
                  type="button"
                  onClick={() => { setShowRecurrence(false); setRecurrence('none'); }}
                  style={collapseLinkStyle}
                >
                  Remove
                </button>
              </div>
              <RecurrencePicker
                value={recurrence}
                onChange={setRecurrence}
                eventDate={eventDate}
                instanceCount={instanceCount}
                onInstanceCountChange={setInstanceCount}
              />
            </div>
          )}

          {/* ── Checkboxes ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '4px', marginBottom: '20px' }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={startTimeRequired}
                onChange={(e) => setStartTimeRequired(e.target.checked)}
                style={{ marginTop: '2px', accentColor: colors.amber }}
              />
              <div>
                <span style={{ fontSize: '13px', color: colors.text }}>Arrive by start time</span>
                <div style={{ fontSize: '11px', color: colors.dim, marginTop: '1px' }}>
                  Uncheck for drop-in events like happy hours
                </div>
              </div>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={wheelchairAccessible === true}
                onChange={(e) => setWheelchairAccessible(e.target.checked ? true : null)}
                style={{ accentColor: colors.amber }}
              />
              <span style={{ fontSize: '13px', color: colors.text }}>Wheelchair accessible</span>
              {accountWheelchairAccessible != null && initialValues.wheelchair_accessible === undefined && (
                <span style={{ fontSize: '11px', color: colors.dim }}>&middot; from venue settings</span>
              )}
            </label>
          </div>

          {/* ── Photo ── */}
          <div>
            <label style={styles.formLabel}>Photo</label>
            {mode === 'edit' && hasExistingImage && !image && (
              <div style={{
                background: colors.bg,
                border: `1px solid ${colors.border}`,
                borderRadius: '8px',
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
                >
                  Remove
                </button>
              </div>
            )}
            <ImageUpload value={image} onChange={setImage} />
            {image && (
              <>
                <ImageCropPreview
                  imageSrc={image}
                  focalY={imageFocalY}
                  onFocalYChange={setImageFocalY}
                />
                <div style={{ marginTop: '16px' }}>
                  <EventPreviews
                    imageSrc={image}
                    focalY={imageFocalY}
                    title={title || 'Event title'}
                    venueName={venueName || 'Venue'}
                    eventDate={eventDate}
                    startTime={startTime}
                    category={category}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {/* Submit */}
        <button
          type="submit"
          className="btn-primary"
          style={{ ...styles.buttonPrimary, marginTop: '16px' }}
          disabled={submitting || !isValid}
        >
          {submitting ? (mode === 'edit' ? 'Saving...' : 'Posting...') : label}
        </button>
      </form>
    </>
  );
}

const expandLinkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: colors.dim,
  fontSize: '13px',
  cursor: 'pointer',
  padding: 0,
  fontFamily: 'inherit',
};

const collapseLinkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: colors.dim,
  fontSize: '12px',
  cursor: 'pointer',
  padding: 0,
  fontFamily: 'inherit',
};
