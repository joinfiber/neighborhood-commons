import { getAccessToken } from './supabase';
import type {
  PortalAccount, PortalEvent, CreateEventParams, PlaceResult,
  CheckEmailResult, WhoamiResponse, PortalStats, AdminPortalEvent,
  SeedAccountParams, ActivityLogEntry,
} from './types';

// Re-export all types for backward compatibility
export type {
  PortalAccount, PortalEvent, CreateEventParams, PlaceResult,
  UserRole, CheckEmailResult, WhoamiResponse, PortalStats,
  AdminPortalEvent, SeedAccountParams, ActivityLogEntry, EventFormData,
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

  try {
    const res = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
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
  default_venue_name?: string;
  default_place_id?: string;
  default_address?: string;
  default_latitude?: number | null;
  default_longitude?: number | null;
  website?: string | null;
  phone?: string | null;
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

export async function deleteEvent(id: string) {
  return apiRequest<{ success: boolean }>(`/api/portal/events/${id}`, { method: 'DELETE' });
}

export async function deleteEventSeries(seriesId: string) {
  return apiRequest<{ success: boolean; deleted: number }>(`/api/portal/events/series/${seriesId}`, { method: 'DELETE' });
}

export async function uploadEventImage(id: string, base64: string) {
  return apiRequest<{ image_url: string }>(`/api/portal/events/${id}/image`, {
    method: 'POST',
    body: JSON.stringify({ image: base64 }),
  });
}

export async function adminUploadEventImage(id: string, base64: string) {
  return apiRequest<{ image_url: string }>(`/api/portal/admin/events/${id}/image`, {
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
// ADMIN API
// =============================================================================

export async function adminFetchStats() {
  return apiRequest<{ stats: PortalStats }>('/api/portal/admin/stats');
}

export async function adminFetchAccounts() {
  return apiRequest<{ accounts: PortalAccount[] }>('/api/portal/admin/accounts');
}

export async function adminFetchAccount(id: string) {
  return apiRequest<{ account: PortalAccount; events: PortalEvent[] }>(`/api/portal/admin/accounts/${id}`);
}

export async function adminSeedAccount(params: SeedAccountParams) {
  return apiRequest<{ account: PortalAccount }>('/api/portal/admin/accounts', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function adminUpdateAccount(id: string, params: Partial<SeedAccountParams & { status: string }>) {
  return apiRequest<{ account: PortalAccount }>(`/api/portal/admin/accounts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(params),
  });
}

export async function adminCreateEvent(accountId: string, params: CreateEventParams) {
  return apiRequest<{ event: PortalEvent }>(`/api/portal/admin/accounts/${accountId}/events`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function adminFetchEvents() {
  return apiRequest<{ events: AdminPortalEvent[] }>('/api/portal/admin/events');
}

export async function adminUpdateEvent(id: string, params: Partial<CreateEventParams>) {
  return apiRequest<{ event: PortalEvent }>(`/api/portal/admin/events/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(params),
  });
}

export async function adminDeleteEvent(id: string) {
  return apiRequest<{ success: boolean }>(`/api/portal/admin/events/${id}`, { method: 'DELETE' });
}

export async function adminApproveAccount(id: string) {
  return apiRequest<{ account: PortalAccount; events_published: number }>(`/api/portal/admin/accounts/${id}/approve`, { method: 'POST' });
}

export async function adminRejectAccount(id: string) {
  return apiRequest<{ success: boolean; events_deleted: number }>(`/api/portal/admin/accounts/${id}/reject`, { method: 'POST' });
}

export async function adminSuspendAccount(id: string) {
  return apiRequest<{ success: boolean; events_suspended: number }>(`/api/portal/admin/accounts/${id}/suspend`, { method: 'POST' });
}

export async function adminReactivateAccount(id: string) {
  return apiRequest<{ success: boolean; events_reactivated: number }>(`/api/portal/admin/accounts/${id}/reactivate`, { method: 'POST' });
}

export async function adminFetchAccountActivity(id: string) {
  return apiRequest<{ activity: ActivityLogEntry[] }>(`/api/portal/admin/accounts/${id}/activity`);
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
