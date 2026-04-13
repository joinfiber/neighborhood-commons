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
  open_window: boolean;
  tags: string[];
  wheelchair_accessible: boolean | null;
  capacity: number | null;
  rsvp: 'recommended' | 'required' | null;
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
  open_window?: boolean;
  tags?: string[];
  wheelchair_accessible?: boolean | null;
  capacity?: number | null;
  rsvp?: 'recommended' | 'required' | null;
}

// =============================================================================
// Contribution Types
// =============================================================================

export interface ContributionBatch {
  id: string;
  status: 'draft' | 'submitted' | 'approved' | 'partially_approved' | 'rejected';
  file_name: string | null;
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  created_events: number;
  created_at: string;
  updated_at: string;
}

export interface ContributionRow {
  id: string;
  row_number: number;
  raw_data: Record<string, string>;
  mapped_data: Record<string, string> | null;
  category_source_term: string | null;
  category_mapped_to: string | null;
  validation_errors: Array<{ field: string; message: string }>;
  status: 'pending' | 'valid' | 'error' | 'skipped' | 'created';
  created_event_id: string | null;
}

export interface CsvUploadResponse {
  batch_id: string;
  headers: string[];
  row_count: number;
  sample_rows: Record<string, string>[];
  suggested_mapping: Record<string, string>;
}

export interface CsvPreviewRow {
  row_number: number;
  name: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  venue_name: string | null;
  category: string;
  description: string | null;
  price: string | null;
  tags: string[];
}

/** Per-row edits made by the contributor in the preview step */
export interface CsvRowOverride {
  name?: string;
  date?: string;
  start_time?: string;
  end_time?: string | null;
  venue_name?: string;
  category?: string;
  custom_category?: string;
  description?: string;
  price?: string;
  tags?: string[];
}

export interface CategoryProposal {
  proposed_name: string;
  justification?: string;
  fallback_category: string;
}

export interface CsvPreviewResponse {
  batch_id: string;
  valid_rows: CsvPreviewRow[];
  error_rows: Array<{ row_number: number; errors: Array<{ field: string; message: string }> }>;
  unmapped_categories: string[];
  category_mappings: Record<string, string>;
  total_valid: number;
  total_errors: number;
}

export interface CsvConfirmResponse {
  created: Array<{ id: string; name: string; row_number: number; status: string }>;
  skipped: Array<{ row_number: number; name: string; reason: string }>;
  total_created: number;
  total_skipped: number;
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
  open_window?: boolean;
  tags?: string[];
  wheelchair_accessible?: boolean | null;
  capacity?: number | null;
  rsvp?: 'recommended' | 'required' | null;
  image?: string | null;
  image_focal_y?: number;
}
