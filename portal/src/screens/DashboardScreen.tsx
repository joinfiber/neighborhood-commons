import { useState, useEffect, useCallback } from 'react';
import { PORTAL_CATEGORIES, PORTAL_CATEGORY_KEYS, type PortalCategory } from '../lib/categories';
import { styles, colors } from '../lib/styles';
import { fetchEvents, batchUpdateEvents, batchDeleteEvents, type PortalEvent, type PortalAccount } from '../lib/api';
import { EventRowSkeleton } from '../components/Skeleton';

interface DashboardScreenProps {
  account: PortalAccount;
  onCreateEvent: () => void;
  onEditEvent: (event: PortalEvent) => void;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTime(time: string): string {
  const [h, m] = time.split(':');
  const hour = parseInt(h!, 10);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 || 12;
  return `${h12}:${m} ${ampm}`;
}

function EventRow({ event, onClick, seriesTotal, selected, onSelect, selectMode }: {
  event: PortalEvent;
  onClick: () => void;
  seriesTotal?: number;
  selected: boolean;
  onSelect: (id: string) => void;
  selectMode: boolean;
}) {
  const cat = PORTAL_CATEGORIES[event.category as PortalCategory];
  const today = new Date().toISOString().split('T')[0]!;
  const isPast = event.event_date < today;

  return (
    <div
      className="interactive-row"
      style={{
        ...styles.eventRow,
        opacity: isPast ? 0.5 : 1,
        borderColor: selected ? colors.amber : colors.border,
        background: selected ? colors.amberDim : colors.card,
      }}
      onClick={() => selectMode ? onSelect(event.id) : onClick()}
    >
      {selectMode && (
        <div
          onClick={(e) => { e.stopPropagation(); onSelect(event.id); }}
          style={{
            width: '22px',
            height: '22px',
            borderRadius: '4px',
            border: `2px solid ${selected ? colors.amber : colors.border}`,
            background: selected ? colors.amber : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: '12px',
            flexShrink: 0,
            cursor: 'pointer',
          }}
        >
          {selected && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '16px', color: colors.cream, fontWeight: 500 }}>
          {event.title}
        </div>
        <div style={{ fontSize: '13px', color: colors.muted, marginTop: '3px' }}>
          {event.venue_name} · {formatDate(event.event_date)} · {formatTime(event.start_time)}
          {event.series_id && seriesTotal && (
            <span style={{ color: colors.dim }}> · {event.series_instance_number} of {seriesTotal}</span>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        {cat && (
          <span style={{ ...styles.pill, ...styles.pillActive, fontSize: '11px', padding: '2px 8px', cursor: 'default' }}>
            {cat.label}
          </span>
        )}
        {event.status === 'pending_review' && (
          <span style={{
            fontSize: '11px',
            color: '#92600a',
            background: '#fef3cd',
            border: '1px solid #fde68a',
            borderRadius: '12px',
            padding: '2px 8px',
          }}>
            pending
          </span>
        )}
        {event.series_id && (
          <span style={{
            fontSize: '11px',
            color: colors.muted,
            background: colors.bg,
            border: `1px solid ${colors.border}`,
            borderRadius: '12px',
            padding: '2px 8px',
          }}>
            series
          </span>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// BULK EDIT PANEL
// =============================================================================

function BulkEditPanel({ selectedCount, onApply, onDelete, onCancel, applying }: {
  selectedCount: number;
  onApply: (updates: Record<string, unknown>) => void;
  onDelete: () => void;
  onCancel: () => void;
  applying: boolean;
}) {
  const [field, setField] = useState<string>('');
  const [category, setCategory] = useState<string>('');
  const [wheelchairAccessible, setWheelchairAccessible] = useState<string>('');
  const [startTimeRequired, setStartTimeRequired] = useState<string>('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleApply = () => {
    const updates: Record<string, unknown> = {};
    if (field === 'category' && category) {
      updates.category = category;
    } else if (field === 'wheelchair') {
      if (wheelchairAccessible === 'true') updates.wheelchair_accessible = true;
      else if (wheelchairAccessible === 'false') updates.wheelchair_accessible = false;
      else if (wheelchairAccessible === 'null') updates.wheelchair_accessible = null;
    } else if (field === 'start_time_required') {
      if (startTimeRequired === 'true') updates.start_time_required = true;
      else if (startTimeRequired === 'false') updates.start_time_required = false;
    }

    if (Object.keys(updates).length > 0) {
      onApply(updates);
    }
  };

  const canApply =
    (field === 'category' && category !== '') ||
    (field === 'wheelchair' && wheelchairAccessible !== '') ||
    (field === 'start_time_required' && startTimeRequired !== '');

  return (
    <div style={{
      ...styles.card,
      marginBottom: '16px',
      borderColor: colors.amberBorder,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
        <span style={{ fontSize: '14px', fontWeight: 500, color: colors.cream }}>
          {selectedCount} event{selectedCount !== 1 ? 's' : ''} selected
        </span>
        <button type="button" style={styles.buttonText} onClick={onCancel}>
          Cancel
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {/* Field picker */}
        <div>
          <label style={styles.formLabel}>Change field</label>
          <select
            style={styles.select}
            value={field}
            onChange={(e) => { setField(e.target.value); }}
          >
            <option value="">Choose a field...</option>
            <option value="category">Category</option>
            <option value="wheelchair">Wheelchair Accessible</option>
            <option value="start_time_required">Arrive by Start Time</option>
          </select>
        </div>

        {/* Category selector */}
        {field === 'category' && (
          <div>
            <label style={styles.formLabel}>New category</label>
            <select style={styles.select} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Choose...</option>
              {PORTAL_CATEGORY_KEYS.map((key) => (
                <option key={key} value={key}>{PORTAL_CATEGORIES[key].label}</option>
              ))}
            </select>
          </div>
        )}

        {/* Wheelchair accessible */}
        {field === 'wheelchair' && (
          <div>
            <label style={styles.formLabel}>Set to</label>
            <select style={styles.select} value={wheelchairAccessible} onChange={(e) => setWheelchairAccessible(e.target.value)}>
              <option value="">Choose...</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
              <option value="null">Use account default</option>
            </select>
          </div>
        )}

        {/* Start time required */}
        {field === 'start_time_required' && (
          <div>
            <label style={styles.formLabel}>Set to</label>
            <select style={styles.select} value={startTimeRequired} onChange={(e) => setStartTimeRequired(e.target.value)}>
              <option value="">Choose...</option>
              <option value="true">Yes — arrive by start time</option>
              <option value="false">No — arrive anytime</option>
            </select>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
          <button
            type="button"
            className="btn-primary"
            style={{ ...styles.buttonPrimary, flex: 1, opacity: canApply && !applying ? 1 : 0.5 }}
            disabled={!canApply || applying}
            onClick={handleApply}
          >
            {applying ? 'Applying...' : 'Apply'}
          </button>
        </div>

        {/* Delete */}
        <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: '10px', marginTop: '4px' }}>
          {confirmDelete ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', color: colors.error }}>
                Delete {selectedCount} event{selectedCount !== 1 ? 's' : ''}?
              </span>
              <button
                type="button"
                style={{ ...styles.buttonText, color: colors.error, fontSize: '13px' }}
                onClick={() => { setConfirmDelete(false); onDelete(); }}
                disabled={applying}
              >
                Yes, delete
              </button>
              <button
                type="button"
                style={{ ...styles.buttonText, fontSize: '13px' }}
                onClick={() => setConfirmDelete(false)}
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              style={{ ...styles.buttonText, color: colors.error, fontSize: '13px', padding: 0 }}
              onClick={() => setConfirmDelete(true)}
              disabled={applying}
            >
              Delete selected events
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// DASHBOARD SCREEN
// =============================================================================

export function DashboardScreen({ account, onCreateEvent, onEditEvent, onSignOut, onSignOutEverywhere }: DashboardScreenProps) {
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [accountExpanded, setAccountExpanded] = useState(false);
  const [confirmSignOutAll, setConfirmSignOutAll] = useState(false);

  // Multi-select state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    const res = await fetchEvents();
    if (res.data) setEvents(res.data.events);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkApply = async (updates: Record<string, unknown>) => {
    setApplying(true);
    setBulkMessage(null);
    const ids = Array.from(selectedIds);
    const res = await batchUpdateEvents(ids, updates);
    setApplying(false);
    if (res.error) {
      setBulkMessage({ text: res.error.message, type: 'error' });
    } else {
      setBulkMessage({ text: `Updated ${res.data?.updated || 0} event${(res.data?.updated || 0) !== 1 ? 's' : ''}`, type: 'success' });
      exitSelectMode();
      loadEvents();
    }
  };

  const handleBulkDelete = async () => {
    setApplying(true);
    setBulkMessage(null);
    const ids = Array.from(selectedIds);
    const result = await batchDeleteEvents(ids);
    setApplying(false);
    setBulkMessage({ text: `Deleted ${result.deleted} event${result.deleted !== 1 ? 's' : ''}`, type: 'success' });
    exitSelectMode();
    loadEvents();
  };

  // Clear bulk message after 3 seconds
  useEffect(() => {
    if (bulkMessage) {
      const t = setTimeout(() => setBulkMessage(null), 3000);
      return () => clearTimeout(t);
    }
  }, [bulkMessage]);

  const today = new Date().toISOString().split('T')[0]!;
  const upcoming = events.filter((e) => e.event_date >= today);
  const past = events.filter((e) => e.event_date < today);

  // Compute series totals for badge display
  const seriesTotals = new Map<string, number>();
  for (const e of events) {
    if (e.series_id) seriesTotals.set(e.series_id, (seriesTotals.get(e.series_id) || 0) + 1);
  }

  // Select all / deselect all for a section
  const selectAllInSection = (sectionEvents: PortalEvent[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = sectionEvents.every((e) => next.has(e.id));
      if (allSelected) {
        for (const e of sectionEvents) next.delete(e.id);
      } else {
        for (const e of sectionEvents) next.add(e.id);
      }
      return next;
    });
  };

  return (
    <div style={styles.page}>
      <div style={styles.content} className="fade-up">
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '28px' }}>
          <div>
            <h1 style={styles.pageTitle}>{account.business_name}</h1>
            <p style={{ fontSize: '13px', color: colors.muted, marginTop: '4px' }}>
              {account.email}
            </p>
          </div>
          <button style={styles.buttonText} onClick={onSignOut}>
            Sign Out
          </button>
        </div>

        {/* Verification banner for pending accounts */}
        {account.status === 'pending' && (
          <div style={{
            background: '#fef3cd',
            border: '1px solid #fde68a',
            borderRadius: '10px',
            padding: '14px 16px',
            marginBottom: '16px',
            fontSize: '14px',
            lineHeight: 1.5,
            color: colors.text,
          }}>
            <strong style={{ color: '#92600a' }}>Account verification in progress</strong>
            <br />
            Your events are saved and ready to go — they'll appear once we verify your business. This usually takes less than 24 hours.
          </div>
        )}

        {/* Account section (collapsible) */}
        <div style={{ ...styles.card, marginBottom: '16px', padding: 0, overflow: 'hidden' }}>
          <button
            type="button"
            onClick={() => setAccountExpanded(!accountExpanded)}
            style={{
              background: 'transparent',
              border: 'none',
              width: '100%',
              padding: '14px 16px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.08em', color: colors.muted }}>
              Account
            </span>
            <span style={{ fontSize: '13px', color: colors.text }}>
              {account.default_address || account.email}
              <span style={{ marginLeft: '8px', fontSize: '10px' }}>{accountExpanded ? '▲' : '▼'}</span>
            </span>
          </button>

          {accountExpanded && (
            <div style={{ padding: '0 16px 16px', borderTop: `1px solid ${colors.border}` }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '14px', paddingTop: '14px' }}>
                <div>
                  <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Email</div>
                  <div style={{ color: colors.cream }}>{account.email}</div>
                </div>
                <div>
                  <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Status</div>
                  <div style={{ color: colors.cream }}>{account.status}</div>
                </div>
                {account.default_venue_name && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Venue</div>
                    <div style={{ color: colors.cream }}>{account.default_venue_name}</div>
                  </div>
                )}
                {account.default_address && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Address</div>
                    <div style={{ color: colors.cream }}>{account.default_address}</div>
                  </div>
                )}
                {account.website && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Website</div>
                    <div style={{ color: colors.cream }}>{account.website}</div>
                  </div>
                )}
                {account.phone && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Phone</div>
                    <div style={{ color: colors.cream }}>{account.phone}</div>
                  </div>
                )}
                {account.wheelchair_accessible != null && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Wheelchair Accessible</div>
                    <div style={{ color: colors.cream }}>{account.wheelchair_accessible ? 'Yes' : 'No'}</div>
                  </div>
                )}
              </div>

              <div style={{ borderTop: `1px solid ${colors.border}`, marginTop: '14px', paddingTop: '14px', display: 'flex', justifyContent: 'flex-end' }}>
                {confirmSignOutAll ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '13px', color: colors.muted }}>Sign out all devices?</span>
                    <button
                      type="button"
                      style={{ ...styles.buttonText, color: colors.error, fontSize: '13px' }}
                      onClick={() => { onSignOutEverywhere(); setConfirmSignOutAll(false); }}
                    >
                      Yes, sign out everywhere
                    </button>
                    <button
                      type="button"
                      style={{ ...styles.buttonText, fontSize: '13px' }}
                      onClick={() => setConfirmSignOutAll(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    style={{ ...styles.buttonText, fontSize: '13px' }}
                    onClick={() => setConfirmSignOutAll(true)}
                  >
                    Sign out everywhere
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Action bar */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
          <button
            style={{ ...styles.buttonPrimary, flex: 1 }}
            onClick={onCreateEvent}
          >
            + New Event
          </button>
          {events.length > 0 && (
            <button
              className="btn-secondary"
              style={{
                ...styles.buttonSecondary,
                width: 'auto',
                padding: '12px 16px',
                fontSize: '14px',
                background: selectMode ? colors.amberDim : 'transparent',
                borderColor: selectMode ? colors.amberBorder : colors.border,
                color: selectMode ? colors.amber : colors.text,
              }}
              onClick={() => selectMode ? exitSelectMode() : setSelectMode(true)}
            >
              {selectMode ? 'Done' : 'Select'}
            </button>
          )}
        </div>

        {/* Bulk message */}
        {bulkMessage && (
          <div style={{
            background: bulkMessage.type === 'success' ? colors.successDim : '#fef2f2',
            color: bulkMessage.type === 'success' ? colors.success : colors.error,
            border: `1px solid ${bulkMessage.type === 'success' ? colors.success + '30' : colors.error + '30'}`,
            borderRadius: '8px',
            padding: '10px 14px',
            fontSize: '14px',
            marginBottom: '16px',
          }}>
            {bulkMessage.text}
          </div>
        )}

        {/* Bulk edit panel */}
        {selectMode && selectedIds.size > 0 && (
          <BulkEditPanel
            selectedCount={selectedIds.size}
            onApply={handleBulkApply}
            onDelete={handleBulkDelete}
            onCancel={exitSelectMode}
            applying={applying}
          />
        )}

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <EventRowSkeleton />
            <EventRowSkeleton />
            <EventRowSkeleton />
          </div>
        ) : events.length === 0 ? (
          <div style={{ ...styles.card, textAlign: 'center', padding: '48px 24px' }}>
            <div style={{ fontSize: '16px', color: colors.cream, marginBottom: '6px' }}>
              No events yet
            </div>
            <div style={{ fontSize: '14px', color: colors.muted }}>
              Create your first event to reach the neighborhood.
            </div>
          </div>
        ) : (
          <>
            {/* Upcoming */}
            {upcoming.length > 0 && (
              <div style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <div style={styles.sectionLabel}>
                    Upcoming ({upcoming.length})
                  </div>
                  {selectMode && (
                    <button
                      type="button"
                      style={{ ...styles.buttonText, fontSize: '12px' }}
                      onClick={() => selectAllInSection(upcoming)}
                    >
                      {upcoming.every((e) => selectedIds.has(e.id)) ? 'Deselect all' : 'Select all'}
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {upcoming.map((event) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      onClick={() => onEditEvent(event)}
                      seriesTotal={event.series_id ? seriesTotals.get(event.series_id) : undefined}
                      selected={selectedIds.has(event.id)}
                      onSelect={toggleSelect}
                      selectMode={selectMode}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Past */}
            {past.length > 0 && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <div style={styles.sectionLabel}>
                    Past ({past.length})
                  </div>
                  {selectMode && (
                    <button
                      type="button"
                      style={{ ...styles.buttonText, fontSize: '12px' }}
                      onClick={() => selectAllInSection(past)}
                    >
                      {past.every((e) => selectedIds.has(e.id)) ? 'Deselect all' : 'Select all'}
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {past.map((event) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      onClick={() => onEditEvent(event)}
                      seriesTotal={event.series_id ? seriesTotals.get(event.series_id) : undefined}
                      selected={selectedIds.has(event.id)}
                      onSelect={toggleSelect}
                      selectMode={selectMode}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
