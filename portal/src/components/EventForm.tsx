import { useState } from 'react';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { styles, colors, categoryColors, spacing, radii } from '../lib/styles';
import type { EventFormData, PlaceResult } from '../lib/types';
import { PORTAL_CATEGORIES, PORTAL_CATEGORY_KEYS, type PortalCategory } from '../lib/categories';
import { CalendarPicker } from './CalendarPicker';
import { TimePicker } from './TimePicker';
import { RecurrencePicker } from './RecurrencePicker';
import { PlaceAutocomplete } from './PlaceAutocomplete';
import { ImageUpload } from './ImageUpload';
import { ImageCropPreview } from './ImageCropPreview';
import { TagPicker } from './TagPicker';
import { getTagsForCategory, AGE_TAGS } from '../lib/tags';

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
// Helpers
// ---------------------------------------------------------------------------

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function isValidUrl(url: string): boolean {
  try { return new URL(url).hostname.includes('.'); }
  catch { return false; }
}

function fmtDate(d: string): string {
  if (!d) return '';
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtTime(t: string): string {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hour = parseInt(h!, 10);
  return `${hour % 12 || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
}

// ---------------------------------------------------------------------------
// Compact "+" trigger
// ---------------------------------------------------------------------------

function AddTrigger({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="btn-text"
      style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
        color: colors.muted, fontSize: '13px', cursor: 'pointer', padding: '6px 0', fontFamily: 'inherit', transition: 'color 0.15s' }}>
      <span style={{ fontSize: '15px', lineHeight: 1, fontWeight: 300 }}>+</span>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Live Preview
// ---------------------------------------------------------------------------

function EventPreview({ title, eventDate, startTime, endTime, venueName, address, category,
  tags, description, price, ticketUrl, image, imageFocalY }: {
  title: string; eventDate: string; startTime: string; endTime: string;
  venueName: string; address: string; category: string; tags: string[];
  description: string; price: string; ticketUrl: string; image: string | null; imageFocalY: number;
}) {
  const catColor = category ? categoryColors[category] : null;
  const catLabel = category ? PORTAL_CATEGORIES[category as PortalCategory]?.label : null;

  if (!title && !eventDate && !venueName) {
    return <div style={{ color: colors.dim, fontSize: '13px', textAlign: 'center', padding: '40px 20px', lineHeight: 1.6 }}>
      Your event listing will appear here as you fill in the details.
    </div>;
  }

  return (
    <div>
      {image && (
        <div style={{ width: '100%', aspectRatio: '16 / 9', borderRadius: radii.md, overflow: 'hidden', marginBottom: '14px', background: colors.border }}>
          <img src={image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: `center ${imageFocalY * 100}%` }} />
        </div>
      )}
      {catLabel && (
        <div style={{ marginBottom: '8px' }}>
          <span style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase',
            padding: '2px 8px', borderRadius: radii.pill, background: catColor?.bg || colors.bg, color: catColor?.fg || colors.muted }}>
            {catLabel}
          </span>
        </div>
      )}
      <div style={{ fontSize: '18px', fontWeight: 600, color: colors.heading, lineHeight: 1.3, letterSpacing: '-0.01em', marginBottom: '6px' }}>
        {title || <span style={{ color: colors.dim }}>Event name</span>}
      </div>
      {(eventDate || startTime) && (
        <div className="tnum" style={{ fontSize: '13px', color: colors.text, marginBottom: '4px', fontWeight: 500 }}>
          {fmtDate(eventDate)}{startTime && <>{eventDate ? ' · ' : ''}{fmtTime(startTime)}</>}{endTime && <> – {fmtTime(endTime)}</>}
        </div>
      )}
      {venueName && <div style={{ fontSize: '13px', color: colors.muted, marginBottom: '2px' }}>{venueName}</div>}
      {address && <div style={{ fontSize: '12px', color: colors.dim, marginBottom: '12px' }}>{address}</div>}
      {price && <div style={{ fontSize: '13px', fontWeight: 500, color: colors.text, marginBottom: '12px' }}>{price}</div>}
      {description && (
        <div style={{ fontSize: '13px', color: colors.text, lineHeight: 1.6, marginBottom: '12px', whiteSpace: 'pre-wrap' }}>
          {description.length > 140 ? description.substring(0, 140) + '...' : description}
        </div>
      )}
      {tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '12px' }}>
          {tags.map((tag) => (
            <span key={tag} style={{ fontSize: '10px', padding: '2px 6px', borderRadius: radii.pill, background: colors.bg, color: colors.dim, border: `1px solid ${colors.border}` }}>
              {tag.replace(/-/g, ' ')}
            </span>
          ))}
        </div>
      )}
      {ticketUrl && (
        <div style={{ fontSize: '12px', color: colors.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ticketUrl.replace(/^https?:\/\//, '')}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Form
// ---------------------------------------------------------------------------

export function EventForm({
  mode, initialValues = {}, hasExistingImage: initialHasExistingImage = false,
  onSubmit, searchCoords, submitting = false, submitLabel, accountWheelchairAccessible,
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

  // Progressive disclosure
  const [showDetails, setShowDetails] = useState(() => !!(initialValues.description || initialValues.price || initialValues.ticket_url));
  const [showEndTime, setShowEndTime] = useState(() => !!initialValues.end_time);
  const [showRecurrence, setShowRecurrence] = useState(() => !!initialValues.recurrence && initialValues.recurrence !== 'none');
  const [showImage, setShowImage] = useState(() => !!initialValues.image || initialHasExistingImage);
  const [showCropTool, setShowCropTool] = useState(false);

  const hasPrefilledVenue = !!(initialValues.venue_name && mode !== 'edit');
  const [editingVenue, setEditingVenue] = useState(!hasPrefilledVenue);

  const { isMobile, isDesktop } = useBreakpoint();

  // ── Handlers ───────────────────────────────────────────────────────────

  function handleCategoryChange(newCategory: string) {
    setCategory(newCategory);
    const allowed = getTagsForCategory(newCategory) as string[];
    const ageSlugs = AGE_TAGS as string[];
    setTags((prev) => {
      const filtered = prev.filter((t) => allowed.includes(t));
      const ageOptions = allowed.filter((t) => ageSlugs.includes(t));
      const singleAge = ageOptions.length === 1 ? ageOptions[0] : undefined;
      if (singleAge && !filtered.some((t) => ageSlugs.includes(t))) return [...filtered, singleAge];
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
      title, venue_name: venueName, event_date: eventDate, start_time: startTime, category, recurrence,
      address: address || undefined, place_id: placeId || undefined, latitude, longitude,
      end_time: endTime || undefined,
      custom_category: category === 'other' ? customCategory || undefined : undefined,
      instance_count: recurrence !== 'none' ? instanceCount : undefined,
      start_time_required: true, tags: tags.length > 0 ? tags : undefined,
      wheelchair_accessible: accountWheelchairAccessible ?? null, rsvp_limit: null,
      description: description || undefined, price: price || undefined,
      ticket_url: ticketUrl ? normalizeUrl(ticketUrl) || undefined : undefined,
      image: image || null, image_focal_y: imageFocalY,
    };
    try {
      const result = await onSubmit(data);
      if (result?.error) setError(result.error);
    } catch { setError('Something went wrong. Please try again.'); }
  }

  const submitLabel_ = submitLabel || (mode === 'edit' ? 'Save Changes' : 'Post Event');
  const isValid = !!(title && venueName && eventDate && startTime && category);
  const hasAvailableTags = !!category && getTagsForCategory(category).length > 0;
  const catColor = category ? categoryColors[category] : null;

  // ── Form ───────────────────────────────────────────────────────────────

  const formContent = (
    <form onSubmit={handleSubmit}>

      {/* ═══ COVER IMAGE ══════════════════════════════════════════════════
          No image: compact dashed trigger
          Has image: thumbnail with hover-to-crop
          ═════════════════════════════════════════════════════════════════ */}

      {showImage ? (
        <div style={{ marginBottom: spacing.lg }}>
          {!image && mode === 'edit' && hasExistingImage ? (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', borderRadius: radii.md, background: colors.bg,
              border: `1px solid ${colors.border}`, fontSize: '12px', color: colors.muted,
            }}>
              <span>Current image attached</span>
              <button type="button" onClick={() => { setHasExistingImage(false); setShowImage(false); }}
                style={{ ...styles.buttonText, color: colors.error, fontSize: '12px' }}>Remove</button>
            </div>
          ) : !image ? (
            <ImageUpload value={image} onChange={(img) => { setImage(img); }} />
          ) : (
            /* Thumbnail with hover crop tool */
            <div
              style={{ position: 'relative', display: 'inline-block', borderRadius: radii.md, overflow: 'hidden', cursor: 'pointer' }}
              onMouseEnter={() => setShowCropTool(true)}
              onMouseLeave={() => setShowCropTool(false)}
            >
              <img src={image} alt="" style={{
                display: 'block', width: '160px', height: '90px', objectFit: 'cover',
                objectPosition: `center ${imageFocalY * 100}%`, borderRadius: radii.md,
              }} />
              {/* Hover overlay with crop tool */}
              {showCropTool && (
                <div style={{
                  position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: radii.md, gap: '8px',
                }}>
                  <button type="button" onClick={() => setShowCropTool(false)}
                    style={{ background: 'rgba(255,255,255,0.9)', border: 'none', borderRadius: radii.sm,
                      padding: '4px 10px', fontSize: '11px', fontWeight: 500, cursor: 'pointer', color: colors.heading }}>
                    Adjust
                  </button>
                  <button type="button" onClick={() => { setImage(null); setShowImage(false); setShowCropTool(false); }}
                    style={{ background: 'rgba(255,255,255,0.9)', border: 'none', borderRadius: radii.sm,
                      padding: '4px 10px', fontSize: '11px', fontWeight: 500, cursor: 'pointer', color: colors.error }}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          )}
          {/* Crop tool — shown when "Adjust" is clicked or on mobile tap */}
          {image && showCropTool && (
            <div style={{ marginTop: '8px', maxWidth: '320px' }}>
              <ImageCropPreview imageSrc={image} focalY={imageFocalY} onFocalYChange={setImageFocalY} />
            </div>
          )}
        </div>
      ) : (
        <button type="button" onClick={() => setShowImage(true)} className="interactive-row"
          style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '12px 16px',
            marginBottom: spacing.lg, background: colors.bg, border: `1px dashed ${colors.border}`,
            borderRadius: radii.md, color: colors.muted, fontSize: '13px', cursor: 'pointer',
            fontFamily: 'inherit', transition: 'border-color 0.15s' }}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
            <circle cx="5.5" cy="6" r="1.5" />
            <path d="M14.5 10.5l-3-3-4 4-2-2-4 4" />
          </svg>
          Add cover image
        </button>
      )}

      {/* ═══ TITLE ════════════════════════════════════════════════════════ */}

      <div style={{ marginBottom: spacing.lg }}>
        <label style={styles.srOnly}>Event name</label>
        <input className="title-input"
          style={{ ...styles.titleInput, background: colors.card, border: `1px solid ${colors.border}`,
            borderRadius: radii.md, padding: '14px 16px' }}
          value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event name" required />
      </div>

      {/* ═══ DATE + TIME SECTION ══════════════════════════════════════════
          Calendar on the left (square, always visible).
          Start time, optional end time stacked on the right.
          Make recurring in its own row below.
          ═════════════════════════════════════════════════════════════════ */}

      <div style={{ marginBottom: spacing.lg }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
          gap: spacing.md,
          alignItems: 'start',
        }}>
          {/* Left: inline calendar */}
          <CalendarPicker value={eventDate} onChange={setEventDate} inline />

          {/* Right: start, end, recurring — all stacked */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div>
              <label style={styles.formLabel}>Start</label>
              <TimePicker value={startTime || '19:00'} onChange={setStartTime} />
            </div>

            {showEndTime ? (
              <div>
                <label style={{ ...styles.formLabel, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  End
                  <button type="button" onClick={() => { setEndTime(''); setShowEndTime(false); }}
                    style={{ background: 'none', border: 'none', color: colors.dim, cursor: 'pointer', fontSize: '13px', padding: 0, fontFamily: 'inherit' }}>
                    ×
                  </button>
                </label>
                <TimePicker value={endTime || '21:00'} onChange={setEndTime} />
              </div>
            ) : (
              <AddTrigger label="End time" onClick={() => { setShowEndTime(true); if (!endTime) setEndTime('21:00'); }} />
            )}

            {showRecurrence ? (
              <div>
                <label style={{ ...styles.formLabel, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  Repeats
                  <button type="button" onClick={() => { setRecurrence('none'); setShowRecurrence(false); }}
                    style={{ background: 'none', border: 'none', color: colors.dim, cursor: 'pointer', fontSize: '12px', padding: 0, fontFamily: 'inherit' }}>×</button>
                </label>
                <RecurrencePicker value={recurrence === 'none' ? 'weekly' : recurrence} onChange={setRecurrence}
                  eventDate={eventDate} instanceCount={instanceCount} onInstanceCountChange={setInstanceCount} />
              </div>
            ) : (
              <AddTrigger label="Make recurring" onClick={() => { setShowRecurrence(true); if (recurrence === 'none') setRecurrence('weekly'); }} />
            )}
          </div>
        </div>
      </div>

      {/* ═══ VENUE ════════════════════════════════════════════════════════ */}

      <div style={{ marginBottom: spacing.lg }}>
        {!editingVenue && venueName ? (
          <div className="interactive-row" onClick={() => setEditingVenue(true)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px',
              background: colors.card, cursor: 'pointer', border: `1px solid ${colors.border}`,
              borderRadius: radii.md, transition: 'border-color 0.15s' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={colors.muted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M8 1.5C5.5 1.5 3.5 3.5 3.5 6c0 3.5 4.5 8.5 4.5 8.5s4.5-5 4.5-8.5c0-2.5-2-4.5-4.5-4.5z" /><circle cx="8" cy="6" r="1.5" />
              </svg>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: '14px', fontWeight: 500, color: colors.text }}>{venueName}</span>
                {address && <span style={{ fontSize: '13px', color: colors.dim, marginLeft: '6px' }}>{address}</span>}
              </div>
            </div>
            <span style={{ fontSize: '12px', color: colors.dim, flexShrink: 0, marginLeft: '12px' }}>Edit</span>
          </div>
        ) : (
          <div>
            <label style={styles.formLabel}>Venue</label>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '10px' }}>
              <PlaceAutocomplete value={venueName} onChange={setVenueName} onSelect={handlePlaceSelect}
                placeholder="Venue name" searchCoords={searchCoords} />
              <input style={styles.input} value={address} onChange={(e) => setAddress(e.target.value)}
                placeholder={mode === 'create' ? 'Auto-fills from venue' : 'Address'} />
            </div>
            {hasPrefilledVenue && (
              <button type="button" onClick={() => setEditingVenue(false)}
                style={{ ...styles.buttonText, padding: '4px 0', marginTop: '6px', fontSize: '12px' }}>Cancel</button>
            )}
          </div>
        )}
      </div>

      {/* ═══ CATEGORY — no label, just the dropdown ══════════════════════ */}

      <div style={{ marginBottom: spacing.lg }}>
        <select
          style={{ ...styles.select, fontFamily: 'inherit',
            ...(catColor ? { borderColor: catColor.fg + '30', backgroundColor: catColor.bg, color: catColor.fg, fontWeight: 500 } : {}) }}
          value={category} onChange={(e) => handleCategoryChange(e.target.value)} required>
          <option value="">Choose category...</option>
          {PORTAL_CATEGORY_KEYS.map((key) => (
            <option key={key} value={key}>{PORTAL_CATEGORIES[key].label}</option>
          ))}
        </select>
        {category === 'other' && (
          <input style={{ ...styles.input, marginTop: '8px' }} value={customCategory}
            onChange={(e) => setCustomCategory(e.target.value)} placeholder="e.g., Book club" maxLength={50} />
        )}
      </div>

      {/* ═══ TAGS — appears only when category has them ═══════════════════ */}

      {hasAvailableTags && (
        <div style={{ marginBottom: spacing.lg }}>
          <TagPicker category={category} value={tags} onChange={setTags} />
        </div>
      )}

      {/* ═══ DETAILS — description, price, link as one group ═════════════
          One "+" trigger opens all three. Each has its own close button.
          ═════════════════════════════════════════════════════════════════ */}

      <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: spacing.md, marginTop: spacing.sm }}>
        {showDetails ? (
          <div>
            {/* Description */}
            <div style={{ marginBottom: spacing.md }}>
              <label style={styles.formLabel}>Description</label>
              <textarea style={{ ...styles.textarea, minHeight: '100px' }} value={description}
                onChange={(e) => setDescription(e.target.value)} placeholder="What should people know about this event?" />
            </div>

            {/* Price + Link side by side */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '10px', marginBottom: spacing.md }}>
              <div>
                <label style={styles.formLabel}>Price</label>
                <input style={styles.input} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Free, $10, $5–15..." />
              </div>
              <div>
                <label style={styles.formLabel}>Link</label>
                <input
                  style={{ ...styles.input, ...(linkError ? { borderColor: colors.error } : {}) }}
                  value={ticketUrl}
                  onChange={(e) => { setTicketUrl(e.target.value); setLinkError(''); }}
                  onBlur={() => {
                    if (!ticketUrl.trim()) { setLinkError(''); return; }
                    const n = normalizeUrl(ticketUrl);
                    if (n !== ticketUrl) setTicketUrl(n);
                    if (!isValidUrl(n)) setLinkError('Enter a valid URL');
                  }}
                  placeholder="eventbrite.com/..." inputMode="url" />
                {linkError && <div style={{ fontSize: '12px', color: colors.error, marginTop: '4px' }}>{linkError}</div>}
              </div>
            </div>

            {/* Collapse if all empty */}
            {!description && !price && !ticketUrl && (
              <button type="button" onClick={() => setShowDetails(false)}
                style={{ ...styles.buttonText, fontSize: '12px', padding: '2px 0', color: colors.dim }}>
                Collapse details
              </button>
            )}
          </div>
        ) : (
          <AddTrigger label="Add description, price, link" onClick={() => setShowDetails(true)} />
        )}
      </div>

      {/* ═══ SUBMIT ═══════════════════════════════════════════════════════ */}

      <div style={isMobile ? styles.stickySubmit : { marginTop: spacing.xl }}>
        <button type="submit" className="btn-primary" style={styles.buttonPrimary} disabled={submitting || !isValid}>
          {submitting ? (mode === 'edit' ? 'Saving...' : 'Posting...') : submitLabel_}
        </button>
      </div>
    </form>
  );

  // ── Layout ─────────────────────────────────────────────────────────────

  return (
    <>
      {error && (
        <div style={{ background: colors.errorBg, color: colors.error, padding: '10px 14px',
          borderRadius: radii.md, fontSize: '14px', marginBottom: spacing.md,
          border: `1px solid ${colors.errorBorder}`, maxWidth: isDesktop ? '1080px' : '680px', width: '100%' }}>
          {error}
        </div>
      )}
      {isDesktop ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: spacing.xxl, maxWidth: '1040px', width: '100%', alignItems: 'start' }}>
          <div>{formContent}</div>
          <div style={{ position: 'sticky', top: '40px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.06em', color: colors.dim, marginBottom: '12px' }}>Preview</div>
            <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: radii.lg, padding: '20px', minHeight: '180px' }}>
              <EventPreview title={title} eventDate={eventDate} startTime={startTime} endTime={endTime}
                venueName={venueName} address={address} category={category} tags={tags}
                description={description} price={price} ticketUrl={ticketUrl} image={image} imageFocalY={imageFocalY} />
            </div>
          </div>
        </div>
      ) : (
        <div style={{ maxWidth: '680px', width: '100%' }}>{formContent}</div>
      )}
    </>
  );
}
