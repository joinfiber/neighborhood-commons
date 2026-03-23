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

export interface PortalStats {
  total_accounts: number;
  claimed_accounts: number;
  managed_accounts: number;
  pending_accounts: number;
  total_events: number;
  events_this_week: number;
}

/** Portal event with joined business info (from admin endpoints). */
export interface AdminPortalEvent extends PortalEvent {
  portal_accounts?: { business_name: string; email: string };
}

export interface SeedAccountParams {
  email: string;
  business_name: string;
  phone?: string;
  website?: string;
  default_venue_name?: string;
  default_address?: string;
}

export interface ActivityLogEntry {
  id: string;
  action: string;
  result: string;
  reason: string | null;
  endpoint: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// =============================================================================
// Newsletter Ingestion Types
// =============================================================================

export interface NewsletterSource {
  id: string;
  name: string;
  sender_email: string | null;
  notes: string | null;
  auto_approve: boolean;
  status: string;
  created_at: string;
  last_received_at: string | null;
}

export interface NewsletterEmail {
  id: string;
  source_id: string | null;
  message_id: string | null;
  sender_email: string;
  subject: string;
  body_html: string | null;
  body_plain: string | null;
  received_at: string;
  processing_status: string;
  processing_error: string | null;
  candidate_count: number | null;
  llm_response: string | null;
  newsletter_sources?: { name: string } | null;
}

export interface FeedSource {
  id: string;
  name: string;
  feed_url: string;
  feed_type: string;
  poll_interval_hours: number;
  status: string;
  default_location: string | null;
  default_timezone: string;
  notes: string | null;
  created_at: string;
  last_polled_at: string | null;
  last_poll_result: string | null;
  last_poll_error: string | null;
  last_event_count: number | null;
}

export interface EventCandidate {
  id: string;
  email_id: string | null;
  source_id: string | null;
  feed_source_id?: string | null;
  title: string;
  description: string | null;
  start_date: string | null;
  start_time: string | null;
  end_time: string | null;
  location_name: string | null;
  location_address: string | null;
  location_lat: number | null;
  location_lng: number | null;
  source_url: string | null;
  confidence: number | null;
  status: string;
  matched_event_id: string | null;
  match_confidence: number | null;
  review_notes: string | null;
  created_at: string;
  reviewed_at: string | null;
  candidate_image_url?: string | null;
  extraction_metadata?: {
    field_confidence: Record<string, number>;
    excerpts: Record<string, string | null>;
  } | null;
  newsletter_emails?: { subject: string } | null;
  newsletter_sources?: { name: string } | null;
  feed_sources?: { name: string } | null;
  price?: string | null;
  category?: string | null;
  tags?: string[] | null;
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
