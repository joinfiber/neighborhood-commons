import { useState, useEffect } from 'react';
import { styles } from '../lib/styles';
import { adminFetchAccounts, adminCreateEvent, adminUploadEventImage } from '../lib/api';
import type { PortalAccount, EventFormData } from '../lib/types';
import { EventForm } from '../components/EventForm';

interface AdminCreateEventScreenProps {
  preSelectedAccountId?: string;
  onBack: () => void;
  onCreated: (title: string, venue: string, date: string) => void;
}

export function AdminCreateEventScreen({ preSelectedAccountId, onBack, onCreated }: AdminCreateEventScreenProps) {
  const [accounts, setAccounts] = useState<PortalAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState(preSelectedAccountId || '');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    adminFetchAccounts().then((res) => {
      if (res.data) setAccounts(res.data.accounts);
    });
  }, []);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  const initialValues: Partial<EventFormData> = {
    venue_name: selectedAccount?.default_venue_name || '',
    address: selectedAccount?.default_address || '',
    latitude: selectedAccount?.default_latitude ?? undefined,
    longitude: selectedAccount?.default_longitude ?? undefined,
  };

  const searchCoords = selectedAccount?.default_latitude && selectedAccount?.default_longitude
    ? { latitude: selectedAccount.default_latitude, longitude: selectedAccount.default_longitude }
    : undefined;

  async function handleSubmit(data: EventFormData) {
    if (!selectedAccountId) return { error: 'Please select an account' };

    setSubmitting(true);
    const { image, ...params } = data;
    const res = await adminCreateEvent(selectedAccountId, params);
    if (res.error) {
      setSubmitting(false);
      return { error: res.error.message };
    }

    if (image && res.data) {
      const raw = image.replace(/^data:[^;]+;base64,/, '');
      await adminUploadEventImage(res.data.event.id, raw);
    }

    setSubmitting(false);
    onCreated(data.title, data.venue_name, data.event_date);
  }

  return (
    <>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
          <button type="button" className="btn-text" style={styles.buttonText} onClick={onBack}>
            ← Back
          </button>
          <h1 style={styles.pageTitle}>
            {selectedAccount ? `Post for ${selectedAccount.business_name}` : 'Post Event'}
          </h1>
        </div>

        {!preSelectedAccountId && (
          <div style={{ ...styles.card, marginBottom: '16px' }}>
            <label style={styles.formLabel}>Business Account</label>
            <select
              style={styles.select}
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              required
            >
              <option value="">Select an account...</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.business_name} ({a.email})</option>
              ))}
            </select>
          </div>
        )}

        <EventForm
          key={selectedAccountId + (selectedAccount ? '-loaded' : '')}
          mode="admin-create"
          initialValues={initialValues}
          onSubmit={handleSubmit}
          searchCoords={searchCoords}
          submitting={submitting}
          accountWheelchairAccessible={selectedAccount?.wheelchair_accessible ?? null}
        />
    </>
  );
}
