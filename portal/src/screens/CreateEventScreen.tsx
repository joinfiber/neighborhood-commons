import { useState } from 'react';
import { styles } from '../lib/styles';
import { createEvent, uploadEventImage } from '../lib/api';
import type { PortalAccount, EventFormData } from '../lib/types';
import { EventForm } from '../components/EventForm';

interface CreateEventScreenProps {
  account: PortalAccount;
  onBack: () => void;
  onCreated: (eventId: string) => void;
}

export function CreateEventScreen({ account, onBack, onCreated }: CreateEventScreenProps) {
  const [submitting, setSubmitting] = useState(false);

  const initialValues: Partial<EventFormData> = {
    venue_name: account.default_venue_name || '',
    address: account.default_address || '',
    place_id: account.default_place_id || '',
    latitude: account.default_latitude ?? undefined,
    longitude: account.default_longitude ?? undefined,
  };

  const searchCoords = account.default_latitude && account.default_longitude
    ? { latitude: account.default_latitude, longitude: account.default_longitude }
    : undefined;

  async function handleSubmit(data: EventFormData) {
    setSubmitting(true);
    const { image, ...params } = data;
    const res = await createEvent(params);
    if (res.error) {
      setSubmitting(false);
      return { error: res.error.message };
    }

    if (image && res.data?.event.id) {
      const raw = image.replace(/^data:[^;]+;base64,/, '');
      await uploadEventImage(res.data.event.id, raw);
    }

    setSubmitting(false);
    onCreated(res.data!.event.id);
  }

  return (
    <div style={styles.page}>
      <div style={styles.content} className="fade-up">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
          <button type="button" className="btn-text" style={styles.buttonText} onClick={onBack}>
            ← Back
          </button>
          <h1 style={styles.pageTitle}>New Event</h1>
        </div>

        <EventForm
          mode="create"
          initialValues={initialValues}
          onSubmit={handleSubmit}
          searchCoords={searchCoords}
          submitting={submitting}
          accountWheelchairAccessible={account.wheelchair_accessible}
        />
      </div>
    </div>
  );
}
