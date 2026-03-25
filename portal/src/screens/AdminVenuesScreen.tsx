import { useState, useEffect, useCallback } from 'react';
import { styles, colors, radii } from '../lib/styles';
import { adminFetchAccounts, adminSeedAccount, scanVenuesByZip, type PortalAccount, type VenueScanResult, type SeedAccountParams } from '../lib/api';
import { EventRowSkeleton } from '../components/Skeleton';

interface AdminVenuesScreenProps {
  onNavigate: (hash: string) => void;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Parse Google's weekday_text into structured operating hours.
 * Input: ["Monday: 11:00 AM – 11:00 PM", "Tuesday: Closed", ...]
 * Output: [{open: true, ranges: [{start: "11:00", end: "23:00"}]}, {open: false, ranges: []}, ...]
 * Google returns days starting Monday; our format is also Mon-Sun.
 */
function parseGoogleHours(weekdayText: string[]): Array<{ open: boolean; ranges: Array<{ start: string; end: string }> }> {
  return weekdayText.map((line) => {
    // Format: "Monday: 11:00 AM – 11:00 PM" or "Monday: Closed" or "Monday: Open 24 hours"
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return { open: false, ranges: [] };
    const timesPart = line.slice(colonIdx + 1).trim();

    if (timesPart.toLowerCase() === 'closed') {
      return { open: false, ranges: [] };
    }
    if (timesPart.toLowerCase().includes('open 24 hours')) {
      return { open: true, ranges: [{ start: '00:00', end: '23:59' }] };
    }

    // Parse time ranges like "11:00 AM – 11:00 PM" or "11:00 AM – 2:00 AM"
    // Could have multiple ranges separated by commas
    const rangeParts = timesPart.split(',').map(s => s.trim());
    const ranges: Array<{ start: string; end: string }> = [];

    for (const part of rangeParts) {
      const match = part.match(/(\d{1,2}:\d{2})\s*(AM|PM)\s*[–-]\s*(\d{1,2}:\d{2})\s*(AM|PM)/i);
      if (match) {
        const start = to24h(match[1]!, match[2]!);
        const end = to24h(match[3]!, match[4]!);
        ranges.push({ start, end });
      }
    }

    return { open: ranges.length > 0, ranges };
  });
}

function to24h(time: string, ampm: string): string {
  const [hStr, m] = time.split(':');
  let h = parseInt(hStr!, 10);
  if (ampm.toUpperCase() === 'PM' && h !== 12) h += 12;
  if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;
  return `${h.toString().padStart(2, '0')}:${m}`;
}

/** Venue types that are rarely event-relevant — shown dimmed with easy dismiss */
const LOW_RELEVANCE_TYPES = new Set([
  'laundromat', 'dry_cleaning', 'car_wash', 'car_repair', 'car_dealer',
  'gas_station', 'atm', 'bank', 'insurance_agency', 'accounting',
  'dentist', 'doctor', 'hospital', 'pharmacy', 'veterinary_care',
  'hair_salon', 'beauty_salon', 'nail_salon', 'barber_shop',
  'real_estate_agency', 'lawyer', 'locksmith', 'plumber', 'electrician',
  'moving_company', 'storage', 'funeral_home', 'post_office',
  'convenience_store', 'supermarket', 'grocery_store',
]);

function isLowRelevance(types: string[]): boolean {
  return types.some(t => LOW_RELEVANCE_TYPES.has(t));
}

function primaryTypeLabel(venue: VenueScanResult): string {
  if (venue.primary_type) return venue.primary_type.replace(/_/g, ' ');
  if (venue.types.length > 0) return venue.types[0]!.replace(/_/g, ' ');
  return '';
}

export function AdminVenuesScreen({ onNavigate }: AdminVenuesScreenProps) {
  const [accounts, setAccounts] = useState<PortalAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Scan state
  const [scanQuery, setScanQuery] = useState('19125');
  const [radiusKm, setRadiusKm] = useState(1.5);
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<VenueScanResult[] | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [dismissedVenues, setDismissedVenues] = useState<VenueScanResult[]>([]);
  const [showDeclined, setShowDeclined] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [expandedVenue, setExpandedVenue] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [tab, setTab] = useState<'existing' | 'import'>('existing');

  const loadData = useCallback(async () => {
    setLoading(true);
    const res = await adminFetchAccounts();
    if (res.data?.accounts) setAccounts(res.data.accounts);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleScan() {
    if (!scanQuery.trim()) return;
    setScanning(true);
    setScanError(null);
    const res = await scanVenuesByZip(scanQuery.trim(), { radius_km: radiusKm });
    setScanning(false);
    if (res.error) {
      setScanError(res.error.message);
      return;
    }
    if (res.data) {
      setScanResults(res.data.venues);
      setDismissed(new Set());
    }
  }

  async function handleImportVenue(venue: VenueScanResult) {
    setImporting(venue.place_id);
    const params: SeedAccountParams = {
      email: `placeholder+${venue.place_id.slice(0, 8)}@neighborhood.commons`,
      business_name: venue.name,
      default_venue_name: venue.name,
      default_place_id: venue.place_id,
      default_address: venue.address || undefined,
      default_latitude: venue.location?.latitude,
      default_longitude: venue.location?.longitude,
      phone: venue.phone || undefined,
      website: venue.website || undefined,
      operating_hours: venue.opening_hours ? parseGoogleHours(venue.opening_hours.weekday_text) : undefined,
    };
    const res = await adminSeedAccount(params);
    setImporting(null);
    if (res.error) {
      setScanError(res.error.message);
      return;
    }
    // Move to dismissed and reload accounts
    setDismissed(prev => new Set([...prev, venue.place_id]));
    loadData();
  }

  // Dedup: match by place_id OR by normalized venue/business name
  const existingPlaceIds = new Set(accounts.map(a => a.default_place_id).filter(Boolean));
  const existingNames = new Set(accounts.flatMap(a => [
    a.business_name.toLowerCase().trim(),
    (a.default_venue_name || '').toLowerCase().trim(),
  ]).filter(Boolean));

  const filtered = accounts
    .filter((a) => {
      if (!search) return true;
      const s = search.toLowerCase();
      return (
        (a.default_venue_name || '').toLowerCase().includes(s) ||
        a.business_name.toLowerCase().includes(s) ||
        a.email.toLowerCase().includes(s)
      );
    })
    .sort((a, b) => (b.event_count || 0) - (a.event_count || 0));

  // Scan results — filter out dismissed and already-imported (by place_id or name)
  const visibleScanResults = scanResults
    ? scanResults.filter(v =>
        !dismissed.has(v.place_id) &&
        !existingPlaceIds.has(v.place_id) &&
        !existingNames.has(v.name.toLowerCase().trim())
      )
    : null;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <h1 style={styles.pageTitle}>Venues</h1>
      </div>

      {/* Tab toggle */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px' }}>
        {([
          { key: 'existing' as const, label: `Existing (${accounts.length})` },
          { key: 'import' as const, label: 'Import from Google' },
        ]).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            style={{
              padding: '7px 16px', fontSize: '13px',
              fontWeight: tab === t.key ? 600 : 400,
              borderRadius: radii.pill,
              border: `1px solid ${tab === t.key ? colors.accent : colors.border}`,
              background: tab === t.key ? colors.accentDim : 'transparent',
              color: tab === t.key ? colors.accent : colors.muted,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Existing venues tab ── */}
      {tab === 'existing' && (
        <>
          <input
            type="text"
            placeholder="Search venues..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...styles.input, marginBottom: '12px', padding: '8px 12px', fontSize: '14px' }}
          />

          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <EventRowSkeleton /><EventRowSkeleton /><EventRowSkeleton />
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ color: colors.dim, fontSize: '14px', padding: '24px', textAlign: 'center' }}>
              {search ? 'No venues match' : 'No venues yet — use Import to add from Google Places'}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                    <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: '11px', fontWeight: 600, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Venue</th>
                    <th style={{ textAlign: 'right', padding: '8px 10px', fontSize: '11px', fontWeight: 600, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Events</th>
                    <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: '11px', fontWeight: 600, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status</th>
                    <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: '11px', fontWeight: 600, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Last Login</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => (
                    <tr key={a.id} className="interactive-row"
                      onClick={() => onNavigate(`#/admin/accounts/${a.id}`)}
                      style={{ borderBottom: `1px solid ${colors.border}`, cursor: 'pointer' }}>
                      <td style={{ padding: '10px 10px' }}>
                        <div style={{ color: colors.cream, fontWeight: 500 }}>
                          {a.default_venue_name || a.business_name}
                        </div>
                        {a.default_venue_name && a.default_venue_name !== a.business_name && (
                          <div style={{ fontSize: '12px', color: colors.dim, marginTop: '2px' }}>
                            {a.business_name}
                          </div>
                        )}
                      </td>
                      <td className="tnum" style={{ padding: '10px', textAlign: 'right', color: colors.muted, fontWeight: 500 }}>
                        {a.event_count || 0}
                      </td>
                      <td style={{ padding: '10px' }}>
                        <span style={{
                          fontSize: '11px', padding: '2px 8px', borderRadius: '10px',
                          background: a.status === 'active' ? colors.successBg : a.status === 'pending' ? colors.pendingBg : colors.errorBg,
                          color: a.status === 'active' ? colors.success : a.status === 'pending' ? colors.pending : colors.error,
                        }}>
                          {a.status}
                        </span>
                      </td>
                      <td style={{ padding: '10px', color: colors.dim, whiteSpace: 'nowrap' }}>
                        {formatDate(a.last_login_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Import tab ── */}
      {tab === 'import' && (
        <>
          {/* Scan bar */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <input
              type="text"
              placeholder="Zip code or area (e.g. 19125)"
              value={scanQuery}
              onChange={(e) => setScanQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleScan(); }}
              style={{ ...styles.input, flex: 1, padding: '9px 12px', fontSize: '14px' }}
            />
            <select
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
              style={{ ...styles.input, width: 'auto', padding: '9px 12px', fontSize: '13px' }}
            >
              <option value={0.5}>0.5 km</option>
              <option value={1}>1 km</option>
              <option value={1.5}>1.5 km</option>
              <option value={2}>2 km</option>
              <option value={3}>3 km</option>
              <option value={5}>5 km</option>
            </select>
            <button
              type="button"
              onClick={handleScan}
              disabled={scanning || !scanQuery.trim()}
              style={{
                ...styles.buttonPrimary,
                width: 'auto', padding: '9px 20px', fontSize: '13px',
                opacity: scanning || !scanQuery.trim() ? 0.5 : 1,
              }}
            >
              {scanning ? 'Scanning...' : 'Scan'}
            </button>
          </div>
          <div style={{ fontSize: '11px', color: colors.dim, marginBottom: '16px' }}>
            Results restricted to venues within the selected radius of the zip code center.
          </div>

          {scanError && (
            <div style={{ color: colors.error, fontSize: '13px', marginBottom: '12px' }}>
              {scanError}
            </div>
          )}

          {scanning && (
            <div style={{ color: colors.dim, fontSize: '14px', padding: '24px', textAlign: 'center' }}>
              Querying Google Places for venues in "{scanQuery}"... This takes 10-20 seconds.
            </div>
          )}

          {visibleScanResults && !scanning && (
            <>
              <div style={{ fontSize: '13px', color: colors.muted, marginBottom: '12px' }}>
                {visibleScanResults.length} venues found
                {dismissed.size > 0 && <span> · {dismissed.size} dismissed</span>}
                {scanResults && existingPlaceIds.size > 0 && (
                  <span> · {scanResults.filter(v => existingPlaceIds.has(v.place_id)).length} already imported</span>
                )}
              </div>

              {visibleScanResults.length === 0 ? (
                <div style={{ color: colors.dim, fontSize: '14px', padding: '24px', textAlign: 'center' }}>
                  All venues dismissed or already imported
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {visibleScanResults.map((venue) => {
                    const lowRelevance = isLowRelevance(venue.types);
                    const expanded = expandedVenue === venue.place_id;
                    return (
                      <div
                        key={venue.place_id}
                        style={{
                          background: colors.card,
                          border: `1px solid ${expanded ? colors.accent : colors.border}`,
                          borderRadius: radii.sm,
                          opacity: lowRelevance ? 0.5 : 1,
                        }}
                      >
                        {/* Collapsed row */}
                        <div
                          onClick={() => setExpandedVenue(expanded ? null : venue.place_id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: '10px',
                            padding: '10px 12px', cursor: 'pointer',
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ fontSize: '14px', fontWeight: 500, color: colors.heading }}>
                                {venue.name}
                              </span>
                              {primaryTypeLabel(venue) && (
                                <span style={{
                                  fontSize: '10px', padding: '1px 6px',
                                  borderRadius: '8px', background: colors.bg, color: colors.muted,
                                }}>
                                  {primaryTypeLabel(venue)}
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: '12px', color: colors.dim, marginTop: '1px' }}>
                              {venue.address}
                              {venue.phone && <span style={{ marginLeft: '8px' }}>· {venue.phone}</span>}
                              {venue.website && <span style={{ marginLeft: '8px' }}>· has website</span>}
                              {venue.opening_hours && <span style={{ marginLeft: '8px' }}>· has hours</span>}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleImportVenue(venue); }}
                            disabled={importing === venue.place_id}
                            style={{
                              padding: '5px 12px', fontSize: '12px', borderRadius: '6px',
                              border: `1px solid ${colors.accent}`, background: colors.card,
                              color: colors.accent, cursor: 'pointer', fontFamily: 'inherit',
                              fontWeight: 500, opacity: importing === venue.place_id ? 0.5 : 1,
                              flexShrink: 0,
                            }}
                          >
                            {importing === venue.place_id ? '...' : 'Import'}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDismissed(prev => new Set([...prev, venue.place_id]));
                              setDismissedVenues(prev => [...prev, venue]);
                            }}
                            style={{
                              padding: '5px 8px', fontSize: '12px', borderRadius: '6px',
                              border: `1px solid ${colors.border}`, background: colors.card,
                              color: colors.dim, cursor: 'pointer', fontFamily: 'inherit',
                              flexShrink: 0,
                            }}
                          >
                            ✕
                          </button>
                        </div>

                        {/* Expanded detail */}
                        {expanded && (
                          <div style={{
                            padding: '0 12px 12px', fontSize: '12px', color: colors.muted,
                            display: 'flex', flexDirection: 'column', gap: '6px',
                            borderTop: `1px solid ${colors.border}`,
                            paddingTop: '10px', marginTop: '0',
                          }}>
                            {venue.phone && (
                              <div><strong style={{ color: colors.heading }}>Phone:</strong> {venue.phone}</div>
                            )}
                            {venue.website && (
                              <div>
                                <strong style={{ color: colors.heading }}>Website:</strong>{' '}
                                <a href={venue.website} target="_blank" rel="noopener noreferrer"
                                  style={{ color: colors.accent, textDecoration: 'none', wordBreak: 'break-all' }}>
                                  {venue.website}
                                </a>
                              </div>
                            )}
                            {venue.google_maps_url && (
                              <div>
                                <a href={venue.google_maps_url} target="_blank" rel="noopener noreferrer"
                                  style={{ color: colors.accent, textDecoration: 'none' }}>
                                  View on Google Maps
                                </a>
                              </div>
                            )}
                            {venue.location && (
                              <div><strong style={{ color: colors.heading }}>Coordinates:</strong> {venue.location.latitude.toFixed(5)}, {venue.location.longitude.toFixed(5)}</div>
                            )}
                            {venue.opening_hours ? (
                              <div>
                                <strong style={{ color: colors.heading }}>Hours:</strong>
                                <div style={{ marginTop: '3px', lineHeight: 1.6 }}>
                                  {venue.opening_hours.weekday_text.map((line, i) => (
                                    <div key={i}>{line}</div>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              <div style={{ color: colors.dim }}>No operating hours listed on Google</div>
                            )}
                            {venue.types.length > 0 && (
                              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '2px' }}>
                                {venue.types.map(t => (
                                  <span key={t} style={{
                                    fontSize: '10px', padding: '1px 6px', borderRadius: '8px',
                                    background: colors.bg, color: colors.dim,
                                  }}>
                                    {t.replace(/_/g, ' ')}
                                  </span>
                                ))}
                              </div>
                            )}
                            {!venue.phone && !venue.website && !venue.opening_hours && (
                              <div style={{ color: colors.dim }}>No additional data available from Google for this venue</div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Declined list */}
          {dismissedVenues.length > 0 && (
            <div style={{ marginTop: '20px' }}>
              <button
                type="button"
                onClick={() => setShowDeclined(!showDeclined)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: '12px', color: colors.dim, fontFamily: 'inherit',
                  padding: '4px 0',
                }}
              >
                {showDeclined ? '▾' : '▸'} Declined ({dismissedVenues.length})
              </button>
              {showDeclined && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '6px' }}>
                  {dismissedVenues.map((venue) => (
                    <div
                      key={venue.place_id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '10px',
                        padding: '6px 12px', fontSize: '13px', color: colors.dim,
                        background: colors.card, border: `1px solid ${colors.border}`,
                        borderRadius: radii.sm,
                      }}
                    >
                      <span style={{ flex: 1 }}>
                        {venue.name}
                        <span style={{ marginLeft: '6px', fontSize: '11px', color: colors.dim }}>
                          {venue.address}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setDismissed(prev => { const next = new Set(prev); next.delete(venue.place_id); return next; });
                          setDismissedVenues(prev => prev.filter(v => v.place_id !== venue.place_id));
                        }}
                        style={{
                          background: 'none', border: `1px solid ${colors.border}`,
                          borderRadius: '6px', padding: '3px 8px', fontSize: '11px',
                          color: colors.muted, cursor: 'pointer', fontFamily: 'inherit',
                          flexShrink: 0,
                        }}
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
