import { useState, useEffect } from 'react';
import { styles, colors } from '../lib/styles';
import { fetchEvent, updateEvent, deleteEvent, deleteEventSeries, uploadEventImage } from '../lib/api';
import type { PortalEvent, EventFormData } from '../lib/types';
import { EventForm } from '../components/EventForm';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface EditEventScreenProps {
  id: string;
  onBack: () => void;
  onUpdated: () => void;
  onDeleted: () => void;
}

export function EditEventScreen({ id, onBack, onUpdated, onDeleted }: EditEventScreenProps) {
  const [event, setEvent] = useState<PortalEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteType, setConfirmDeleteType] = useState<'event' | 'series' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchEvent(id).then((res) => {
      if (res.data) setEvent(res.data.event);
      else setError(res.error?.message || 'Failed to load event');
      setLoading(false);
    });
  }, [id]);

  async function handleSubmit(data: EventFormData) {
    if (!event) return;
    setSubmitting(true);
    const { image, ...params } = data;
    const res = await updateEvent(event.id, params);
    if (res.error) {
      setSubmitting(false);
      return { error: res.error.message };
    }

    if (image) {
      const raw = image.replace(/^data:[^;]+;base64,/, '');
      await uploadEventImage(event.id, raw);
    }

    setSubmitting(false);
    onUpdated();
  }

  async function handleConfirmDelete() {
    if (!event) return;
    setDeleting(true);
    setError(null);

    if (confirmDeleteType === 'series' && event.series_id) {
      const res = await deleteEventSeries(event.series_id);
      if (res.error) {
        setError(res.error.message);
        setDeleting(false);
        setConfirmDeleteType(null);
        return;
      }
    } else {
      const res = await deleteEvent(event.id);
      if (res.error) {
        setError(res.error.message);
        setDeleting(false);
        setConfirmDeleteType(null);
        return;
      }
    }

    setConfirmDeleteType(null);
    onDeleted();
  }

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.ambientGlow} />
        <div style={styles.content}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
            <button type="button" className="btn-text" style={styles.buttonText} onClick={onBack}>
              ← Back
            </button>
            <h1 style={styles.pageTitle}>Edit Event</h1>
          </div>
          <div style={{ color: colors.dim, fontSize: '14px', padding: '24px 0' }}>Loading...</div>
        </div>
      </div>
    );
  }

  if (!event) {
    return (
      <div style={styles.page}>
        <div style={styles.ambientGlow} />
        <div style={styles.content}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
            <button type="button" className="btn-text" style={styles.buttonText} onClick={onBack}>
              ← Back
            </button>
            <h1 style={styles.pageTitle}>Edit Event</h1>
          </div>
          <div style={{
            background: '#2a1a18',
            color: colors.error,
            padding: '10px 14px',
            borderRadius: '8px',
            fontSize: '13px',
          }}>
            {error || 'Event not found'}
          </div>
        </div>
      </div>
    );
  }

  const initialValues: Partial<EventFormData> = {
    title: event.title,
    venue_name: event.venue_name,
    address: event.address || '',
    place_id: event.place_id || '',
    latitude: event.latitude ?? undefined,
    longitude: event.longitude ?? undefined,
    event_date: event.event_date,
    start_time: event.start_time,
    end_time: event.end_time || '',
    category: event.category,
    custom_category: event.custom_category || '',
    recurrence: event.recurrence,
    description: event.description || '',
    price: event.price || '',
    ticket_url: event.ticket_url || '',
    image_focal_y: event.image_focal_y,
  };

  return (
    <div style={styles.page}>
      <div style={styles.ambientGlow} />
      <div style={styles.content} className="fade-up">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
          <button type="button" className="btn-text" style={styles.buttonText} onClick={onBack}>
            ← Back
          </button>
          <h1 style={styles.pageTitle}>Edit Event</h1>
        </div>

        {event.series_id && (
          <div style={{
            background: colors.bg,
            border: `1px solid ${colors.border}`,
            borderRadius: '8px',
            padding: '8px 12px',
            marginBottom: '16px',
            fontSize: '12px',
            color: colors.muted,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <span>Part of a series (instance {event.series_instance_number})</span>
            <button
              type="button"
              className="btn-text"
              onClick={() => setConfirmDeleteType('series')}
              style={{ background: 'none', border: 'none', color: colors.dim, cursor: 'pointer', fontSize: '11px', textDecoration: 'underline' }}
              disabled={deleting}
            >
              Delete entire series
            </button>
          </div>
        )}

        {error && (
          <div style={{
            background: '#2a1a18',
            color: colors.error,
            padding: '10px 14px',
            borderRadius: '8px',
            fontSize: '13px',
            marginBottom: '16px',
          }}>
            {error}
          </div>
        )}

        <EventForm
          mode="edit"
          initialValues={initialValues}
          hasExistingImage={!!event.image_url}
          onSubmit={handleSubmit}
          submitting={submitting}
        />

        <button
          type="button"
          className="btn-secondary"
          style={{
            ...styles.buttonSecondary,
            marginTop: '10px',
            borderColor: colors.border,
            color: colors.muted,
          }}
          onClick={() => setConfirmDeleteType('event')}
          disabled={deleting}
        >
          {deleting ? 'Deleting...' : 'Delete Event'}
        </button>

        {confirmDeleteType && (
          <ConfirmDialog
            title={confirmDeleteType === 'series' ? 'Delete Series' : 'Delete Event'}
            message={
              confirmDeleteType === 'series'
                ? 'This will delete all events in this series. This cannot be undone.'
                : 'This will permanently delete this event. This cannot be undone.'
            }
            confirmLabel="Delete"
            destructive
            loading={deleting}
            onConfirm={handleConfirmDelete}
            onCancel={() => setConfirmDeleteType(null)}
          />
        )}
      </div>
    </div>
  );
}
