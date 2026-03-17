import { useState, useEffect } from 'react';
import { styles, colors } from '../lib/styles';
import { adminFetchAccount, adminUpdateEvent, adminUpdateEventSeries, adminDeleteEvent, adminUploadEventImage } from '../lib/api';
import type { PortalAccount, PortalEvent, EventFormData } from '../lib/types';
import { EventForm } from '../components/EventForm';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface AdminEditEventScreenProps {
  eventId: string;
  accountId: string;
  onBack: () => void;
  onUpdated: () => void;
  onDeleted: () => void;
}

export function AdminEditEventScreen({ eventId, accountId, onBack, onUpdated, onDeleted }: AdminEditEventScreenProps) {
  const [account, setAccount] = useState<PortalAccount | null>(null);
  const [event, setEvent] = useState<PortalEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [seriesEditChoice, setSeriesEditChoice] = useState<null | { data: EventFormData }>(null);
  const [seriesResult, setSeriesResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    adminFetchAccount(accountId).then((res) => {
      if (res.data) {
        setAccount(res.data.account);
        const found = res.data.events.find((e) => e.id === eventId);
        if (found) setEvent(found);
        else setError('Event not found');
      } else {
        setError(res.error?.message || 'Failed to load event');
      }
      setLoading(false);
    });
  }, [eventId, accountId]);

  async function handleSubmit(data: EventFormData) {
    if (!event) return;

    // If this is a series event, ask which scope to apply
    if (event.series_id) {
      setSeriesEditChoice({ data });
      return;
    }

    return applyUpdate(data, 'single');
  }

  async function applyUpdate(data: EventFormData, scope: 'single' | 'all_upcoming') {
    if (!event) return;
    setSubmitting(true);
    setSeriesEditChoice(null);
    setSeriesResult(null);
    const { image, ...params } = data;

    if (scope === 'all_upcoming' && event.series_id) {
      const res = await adminUpdateEventSeries(event.series_id, params);
      if (res.error) {
        setSubmitting(false);
        return { error: res.error.message };
      }

      if (image) {
        const raw = image.replace(/^data:[^;]+;base64,/, '');
        await adminUploadEventImage(event.id, raw);
      }

      setSubmitting(false);
      const parts = [`Updated ${res.data!.updated} of ${res.data!.total} upcoming events`];
      if (res.data!.added > 0) parts.push(`+${res.data!.added} added`);
      if (res.data!.removed > 0) parts.push(`${res.data!.removed} removed`);
      setSeriesResult(parts.join(', '));
      setTimeout(() => onUpdated(), 1500);
      return;
    }

    const res = await adminUpdateEvent(event.id, params);
    if (res.error) {
      setSubmitting(false);
      return { error: res.error.message };
    }

    if (image) {
      const raw = image.replace(/^data:[^;]+;base64,/, '');
      await adminUploadEventImage(event.id, raw);
    }

    setSubmitting(false);
    onUpdated();
  }

  async function handleConfirmDelete() {
    if (!event) return;
    setDeleting(true);
    setError(null);

    const res = await adminDeleteEvent(event.id);
    if (res.error) {
      setError(res.error.message);
      setDeleting(false);
      setConfirmDelete(false);
      return;
    }

    setConfirmDelete(false);
    onDeleted();
  }

  if (loading) {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
          <button type="button" className="btn-text" style={styles.buttonText} onClick={onBack}>
            ← Back
          </button>
          <h1 style={styles.pageTitle}>Edit Event</h1>
        </div>
        <div style={{ color: colors.dim, fontSize: '16px', padding: '24px 0' }}>Loading...</div>
      </>
    );
  }

  if (!event) {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
          <button type="button" className="btn-text" style={styles.buttonText} onClick={onBack}>
            ← Back
          </button>
          <h1 style={styles.pageTitle}>Edit Event</h1>
        </div>
        <div style={{
          background: '#fef2f2',
          color: colors.error,
          padding: '10px 14px',
          borderRadius: '8px',
          fontSize: '14px',
        }}>
          {error || 'Event not found'}
        </div>
      </>
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
    start_time_required: event.start_time_required,
    tags: event.tags || [],
    wheelchair_accessible: event.wheelchair_accessible,
    rsvp_limit: event.rsvp_limit,
    image_focal_y: event.image_focal_y,
  };

  return (
    <>
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
          }}>
            Part of a recurring series (instance {event.series_instance_number})
          </div>
        )}

        {seriesResult && (
          <div style={{
            background: '#f0fdf4',
            border: '1px solid #bbf7d0',
            color: colors.success,
            padding: '10px 14px',
            borderRadius: '8px',
            fontSize: '13px',
            marginBottom: '16px',
          }}>
            {seriesResult}
          </div>
        )}

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

        <EventForm
          mode="edit"
          initialValues={initialValues}
          hasExistingImage={!!event.image_url}
          onSubmit={handleSubmit}
          submitting={submitting}
          accountWheelchairAccessible={account?.wheelchair_accessible ?? null}
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
          onClick={() => setConfirmDelete(true)}
          disabled={deleting}
        >
          {deleting ? 'Deleting...' : 'Delete Event'}
        </button>

        {confirmDelete && (
          <ConfirmDialog
            title="Delete Event"
            message="This will permanently delete this event. This cannot be undone."
            confirmLabel="Delete"
            destructive
            loading={deleting}
            onConfirm={handleConfirmDelete}
            onCancel={() => setConfirmDelete(false)}
          />
        )}

        {seriesEditChoice && (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}>
            <div style={{
              background: colors.card, border: `1px solid ${colors.border}`,
              borderRadius: '12px', padding: '24px', maxWidth: '380px', width: '90%',
            }}>
              <h3 style={{ margin: '0 0 8px 0', fontSize: '16px', color: colors.cream }}>
                Edit recurring event
              </h3>
              <p style={{ margin: '0 0 20px 0', fontSize: '13px', color: colors.muted, lineHeight: 1.6 }}>
                This event is part of a series. Apply your changes to just this instance, or all upcoming events?
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => void applyUpdate(seriesEditChoice.data, 'single')}
                  disabled={submitting}
                  style={{
                    ...styles.buttonPrimary,
                    background: colors.bg, border: `1px solid ${colors.border}`,
                    color: colors.text, fontSize: '13px', padding: '10px 16px',
                    cursor: 'pointer', borderRadius: '8px',
                  }}
                >
                  This event only
                </button>
                <button
                  type="button"
                  onClick={() => void applyUpdate(seriesEditChoice.data, 'all_upcoming')}
                  disabled={submitting}
                  style={{
                    ...styles.buttonPrimary,
                    fontSize: '13px', padding: '10px 16px',
                    cursor: 'pointer', borderRadius: '8px',
                  }}
                >
                  {submitting ? 'Updating...' : 'All upcoming events'}
                </button>
                <button
                  type="button"
                  onClick={() => setSeriesEditChoice(null)}
                  disabled={submitting}
                  style={{
                    background: 'none', border: 'none', color: colors.dim,
                    fontSize: '12px', cursor: 'pointer', padding: '8px',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
    </>
  );
}
