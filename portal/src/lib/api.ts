import { getAccessToken } from './supabase';
import type {
  PortalAccount, PortalEvent, CreateEventParams, PlaceResult,
  CheckEmailResult, WhoamiResponse,
} from './types';

// Re-export all types for backward compatibility
export type {
  PortalAccount, PortalEvent, CreateEventParams, PlaceResult,
  UserRole, CheckEmailResult, WhoamiResponse, EventFormData,
} from './types';

const API_URL = import.meta.env.VITE_API_URL || '';
const TIMEOUT_MS = 30000;

interface ApiError { code: string; message: string }
interface ApiResponse<T> { data?: T; error?: ApiError }

async function apiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  const token = await getAccessToken();
  if (!token) return { error: { code: 'NO_TOKEN', message: 'Not authenticated' } };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...(options.headers as Record<string, string>),
  };

  try {
    const res = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers,
    });

    if (res.status === 429) return { error: { code: 'RATE_LIMIT', message: 'Too many requests' } };

    const data = await res.json();
    if (!res.ok) return { error: data.error || { code: 'UNKNOWN', message: 'Request failed' } };
    return { data };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { error: { code: 'TIMEOUT', message: 'Request timed out' } };
    }
    return { error: { code: 'NETWORK', message: String(err) } };
  } finally {
    clearTimeout(timeout);
  }
}

// =============================================================================
// PRE-AUTH (no token needed)
// =============================================================================

export async function checkPortalEmail(email: string): Promise<CheckEmailResult> {
  try {
    const res = await fetch(`${API_URL}/api/portal/auth/check-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { allowed: false, error: data.error?.message || 'Access denied' };
    }
    if (data.canSignUp) {
      return { allowed: false, canSignUp: true };
    }
    return { allowed: true, role: data.role || 'business' };
  } catch {
    return { allowed: false, error: 'Network error' };
  }
}

export async function registerAccount(
  email: string,
  businessName: string,
  captchaToken: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_URL}/api/portal/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, business_name: businessName, captchaToken }),
    });
    if (!res.ok) {
      const data = await res.json();
      return { success: false, error: data.error?.message || 'Registration failed' };
    }
    return { success: true };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

// =============================================================================
// ACCOUNT
// =============================================================================

export async function claimAccount() {
  return apiRequest<{ account: PortalAccount }>('/api/portal/account/claim', { method: 'POST' });
}

export async function fetchAccount() {
  return apiRequest<{ account: PortalAccount }>('/api/portal/account');
}

export async function updateProfile(params: {
  business_name?: string;
  default_venue_name?: string;
  default_place_id?: string;
  default_address?: string;
  default_latitude?: number | null;
  default_longitude?: number | null;
  website?: string | null;
  phone?: string | null;
  wheelchair_accessible?: boolean | null;
  operating_hours?: Array<{ open: boolean; ranges: Array<{ start: string; end: string }> }> | null;
}) {
  return apiRequest<{ account: PortalAccount }>('/api/portal/account/profile', {
    method: 'PATCH',
    body: JSON.stringify(params),
  });
}

// =============================================================================
// EVENTS
// =============================================================================

export async function fetchEvents() {
  return apiRequest<{ events: PortalEvent[] }>('/api/portal/events');
}

export async function fetchEvent(id: string) {
  return apiRequest<{ event: PortalEvent }>(`/api/portal/events/${id}`);
}

export async function createEvent(params: CreateEventParams) {
  return apiRequest<{ event: PortalEvent }>('/api/portal/events', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function updateEvent(id: string, params: Partial<CreateEventParams>) {
  return apiRequest<{ event: PortalEvent }>(`/api/portal/events/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(params),
  });
}

export async function updateEventSeries(seriesId: string, params: Partial<CreateEventParams> & { force?: boolean }) {
  return apiRequest<{ updated: number; total: number }>(`/api/portal/events/series/${seriesId}`, {
    method: 'PATCH',
    body: JSON.stringify(params),
  });
}

export async function batchUpdateEvents(ids: string[], updates: Partial<CreateEventParams>) {
  return apiRequest<{ updated: number; ids: string[] }>('/api/portal/events/batch', {
    method: 'PATCH',
    body: JSON.stringify({ ids, updates }),
  });
}

export async function batchDeleteEvents(ids: string[]) {
  // Sequential deletes — no batch delete endpoint, but clean UX
  const results: string[] = [];
  for (const id of ids) {
    const res = await apiRequest<{ success: boolean }>(`/api/portal/events/${id}`, { method: 'DELETE' });
    if (res.data?.success) results.push(id);
  }
  return { deleted: results.length, ids: results };
}

export async function deleteEvent(id: string) {
  return apiRequest<{ success: boolean }>(`/api/portal/events/${id}`, { method: 'DELETE' });
}

export async function deleteEventSeries(seriesId: string) {
  return apiRequest<{ success: boolean; deleted: number }>(`/api/portal/events/series/${seriesId}`, { method: 'DELETE' });
}

export async function extendEventSeries(seriesId: string) {
  return apiRequest<{ added: number; total: number }>(`/api/portal/events/series/${seriesId}/extend`, { method: 'POST' });
}

export async function uploadEventImage(id: string, base64: string) {
  return apiRequest<{ image_url: string }>(`/api/portal/events/${id}/image`, {
    method: 'POST',
    body: JSON.stringify({ image: base64 }),
  });
}

// =============================================================================
// WHOAMI (role detection after auth)
// =============================================================================

export async function fetchWhoami() {
  return apiRequest<WhoamiResponse>('/api/portal/whoami');
}

// =============================================================================
// IMPORT
// =============================================================================

export interface ImportPreviewEvent {
  index: number;
  name: string;
  start: string;
  end: string | null;
  timezone: string;
  venue_name: string | null;
  address: string | null;
  description: string | null;
  cost: string | null;
  external_id: string | null;
  already_exists: boolean;
  recurrence: string | null;
  image_url: string | null;
}

export interface ImportPreviewResponse {
  source_type: 'ical' | 'eventbrite';
  source_url: string;
  events: ImportPreviewEvent[];
  warnings: string[];
  total_parsed: number;
}

export interface ImportConfirmResponse {
  created: Array<{ id: string; name: string; status: string }>;
  skipped: Array<{ name: string; reason: string }>;
  total_created: number;
  total_skipped: number;
}

export async function importPreview(url: string, category: string, event_timezone: string) {
  return apiRequest<ImportPreviewResponse>('/api/portal/import/preview', {
    method: 'POST',
    body: JSON.stringify({ url, category, event_timezone }),
  });
}

export async function importConfirm(params: {
  url: string;
  source_type: 'ical' | 'eventbrite';
  category: string;
  event_timezone: string;
  events: number[];
  overrides?: Record<string, { venue_name?: string; category?: string; description?: string; image_focal_y?: number }>;
}) {
  return apiRequest<ImportConfirmResponse>('/api/portal/import/confirm', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// =============================================================================
// PLACES
// =============================================================================

const PHILLY_COORDS = { latitude: 39.9526, longitude: -75.1652 };

export async function searchPlaces(
  query: string,
  coords?: { latitude: number; longitude: number },
): Promise<PlaceResult[]> {
  const { latitude, longitude } = coords ?? PHILLY_COORDS;
  const res = await apiRequest<{ results: PlaceResult[] }>('/api/places/search', {
    method: 'POST',
    body: JSON.stringify({ query, latitude, longitude, radius: 25000 }),
  });
  return res.data?.results || [];
}
