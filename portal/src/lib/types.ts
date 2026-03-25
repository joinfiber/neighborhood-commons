// =============================================================================
// Portal Types
// =============================================================================

export type UserRole = 'business' | 'admin';

export interface PortalAccount {
  id: string;
  email: string;
  business_name: string;
  default_venue_name: string | null;
  default_place_id: string | null;
  default_address: string | null;
  default_latitude: number | null;
  default_longitude: number | null;
  claimed_at: string | null;
  last_login_at: string | null;
  phone: string | null;
  website: string | null;
  wheelchair_accessible: boolean | null;
  operating_hours: Array<{ open: boolean; ranges: Array<{ start: string; end: string }> }> | null;
  status: string;
  created_at: string;
  event_count?: number;
}

export interface PortalEvent {
  id: string;
  portal_account_id: string;
  title: string;
  description: string | null;
  venue_name: string;
  address: string | null;
  place_id: string | null;
  latitude: number | null;
  longitude: number | null;
  event_date: string | null;
  start_time: string | null;
  end_time: string | null;
  category: string;
  custom_category: string | null;
  recurrence: string;
  price: string | null;
  ticket_url: string | null;
  image_url: string | null;
  image_focal_y: number;
  status: string;
  start_time_required: boolean;
  tags: string[];
  wheelchair_accessible: boolean | null;
  rsvp_limit: number | null;
  series_id: string | null;
  series_instance_number: number | null;
  created_at: string;
  updated_at?: string;
}

export interface CreateEventParams {
  title: string;
  venue_name: string;
  address?: string;
  place_id?: string;
  latitude?: number;
  longitude?: number;
  event_date: string;
  start_time: string;
  end_time?: string;
  category: string;
  custom_category?: string;
  recurrence?: string;
  instance_count?: number;
  description?: string;
  price?: string;
  ticket_url?: string;
  image_focal_y?: number;
  start_time_required?: boolean;
  tags?: string[];
  wheelchair_accessible?: boolean | null;
  rsvp_limit?: number | null;
}

export interface PlaceResult {
  place_id: string;
  name: string;
  address: string | null;
  location: { latitude: number; longitude: number } | null;
}

export interface CheckEmailResult {
  allowed: boolean;
  canSignUp?: boolean;
  role?: UserRole;
  error?: string;
}

export interface WhoamiResponse {
  role: UserRole;
  email?: string;
  account?: PortalAccount;
  impersonating?: boolean;
}

/** Data shape for the unified event form */
export interface EventFormData {
  title: string;
  venue_name: string;
  address?: string;
  place_id?: string;
  latitude?: number;
  longitude?: number;
  event_date: string;
  start_time: string;
  end_time?: string;
  category: string;
  custom_category?: string;
  recurrence: string;
  instance_count?: number;
  description?: string;
  price?: string;
  ticket_url?: string;
  start_time_required?: boolean;
  tags?: string[];
  wheelchair_accessible?: boolean | null;
  rsvp_limit?: number | null;
  image?: string | null;
  image_focal_y?: number;
}
