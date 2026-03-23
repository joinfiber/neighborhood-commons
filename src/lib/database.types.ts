/**
 * Database Types — Neighborhood Commons
 *
 * Generated from Supabase schema. Provides compile-time column checking
 * for all database queries via the typed Supabase client.
 *
 * REGENERATE after any migration:
 *   npm run db:types
 *
 * This runs:
 *   npx supabase gen types typescript --project-id <id> > src/lib/database.types.ts
 *
 * Until the first generation, this file provides a minimal Database type
 * that makes the Supabase client aware of table names without full column types.
 * After generation, this entire file is replaced by the Supabase CLI output.
 */

export type Database = {
  public: {
    Tables: {
      events: {
        Row: {
          id: string;
          content: string;
          description: string | null;
          event_at: string;
          end_time: string | null;
          event_timezone: string;
          place_id: string | null;
          place_name: string | null;
          venue_address: string | null;
          latitude: number | null;
          longitude: number | null;
          approximate_location: unknown | null;
          location: unknown | null;
          region_id: string | null;
          category: string;
          custom_category: string | null;
          price: string | null;
          link_url: string | null;
          event_image_url: string | null;
          event_image_focal_y: number;
          source: string;
          creator_account_id: string | null;
          user_id: string;
          is_business: boolean;
          visibility: string;
          status: string;
          broadcast_mode: string | null;
          discovery_radius_meters: number | null;
          recurrence: string;
          series_id: string | null;
          series_instance_number: number | null;
          becomes_visible_at: string | null;
          expires_at: string | null;
          ended_at: string | null;
          start_time_required: boolean;
          tags: string[];
          wheelchair_accessible: boolean | null;
          rsvp_limit: number | null;
          source_method: string | null;
          source_publisher: string | null;
          source_feed_url: string | null;
          external_id: string | null;
          runtime_minutes: number | null;
          content_rating: string | null;
          showtimes: unknown | null;
          created_at: string;
          updated_at: string;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Insert: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Update: any;
      };
      portal_accounts: {
        Row: {
          id: string;
          auth_user_id: string | null;
          email: string;
          business_name: string;
          phone: string | null;
          website: string | null;
          default_venue_name: string | null;
          default_address: string | null;
          default_place_id: string | null;
          default_latitude: number | null;
          default_longitude: number | null;
          logo_url: string | null;
          description: string | null;
          status: string;
          slug: string | null;
          claimed_at: string | null;
          wheelchair_accessible: boolean | null;
          last_login_at: string | null;
          created_at: string;
          updated_at: string;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Insert: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Update: any;
      };
      event_series: {
        Row: {
          id: string;
          creator_account_id: string;
          user_id: string;
          recurrence: string;
          recurrence_rule: unknown | null;
          base_event_data: unknown | null;
          created_at: string;
          updated_at: string;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Insert: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Update: any;
      };
      regions: {
        Row: {
          id: string;
          name: string;
          slug: string;
          type: string;
          parent_id: string | null;
          timezone: string;
          is_active: boolean;
          created_at: string;
          updated_at: string | null;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Insert: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Update: any;
      };
      api_keys: {
        Row: {
          id: string;
          name: string;
          key_hash: string;
          key_prefix: string;
          contact_email: string;
          tier: string;
          rate_limit_per_hour: number;
          status: string;
          contributor_tier: string | null;
          last_used_at: string | null;
          created_at: string;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Insert: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Update: any;
      };
      webhook_subscriptions: {
        Row: {
          id: string;
          api_key_id: string;
          url: string;
          signing_secret: string | null;
          signing_secret_encrypted: unknown | null;
          event_types: string[];
          status: string;
          consecutive_failures: number;
          last_success_at: string | null;
          last_failure_at: string | null;
          last_failure_reason: string | null;
          disabled_at: string | null;
          created_at: string;
          updated_at: string;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Insert: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Update: any;
      };
      webhook_deliveries: {
        Row: {
          id: number;
          subscription_id: string;
          event_type: string;
          event_id: string;
          status: string;
          status_code: number | null;
          error_message: string | null;
          attempt: number;
          next_retry_at: string | null;
          created_at: string;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Insert: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Update: any;
      };
      audit_logs: {
        Row: {
          id: string;
          action: string;
          actor_hash: string;
          resource_hash: string;
          result: string;
          reason: string | null;
          endpoint: string | null;
          ip_hash: string | null;
          user_agent: string | null;
          metadata: unknown;
          resource_id: string | null;
          created_at: string;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Insert: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Update: any;
      };
      newsletter_sources: {
        Row: {
          id: string;
          name: string;
          sender_email: string | null;
          notes: string | null;
          auto_approve: boolean;
          status: string;
          created_at: string;
          last_received_at: string | null;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Insert: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Update: any;
      };
      newsletter_emails: {
        Row: {
          id: string;
          source_id: string | null;
          message_id: string | null;
          sender_email: string;
          subject: string;
          body_html: string | null;
          body_plain: string | null;
          received_at: string | null;
          processing_status: string;
          processing_error: string | null;
          candidate_count: number | null;
          llm_response: string | null;
          created_at: string;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Insert: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Update: any;
      };
      event_candidates: {
        Row: {
          id: string;
          email_id: string | null;
          source_id: string | null;
          feed_source_id: string | null;
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
          extraction_metadata: unknown | null;
          candidate_image_url: string | null;
          price: string | null;
          category: string | null;
          tags: string[] | null;
          created_at: string;
          reviewed_at: string | null;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Insert: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Update: any;
      };
      feed_sources: {
        Row: {
          id: string;
          name: string;
          feed_url: string;
          feed_type: string;
          poll_interval_hours: number;
          status: string;
          default_location: unknown | null;
          default_timezone: string | null;
          notes: string | null;
          created_at: string;
          last_polled_at: string | null;
          last_poll_result: string | null;
          last_poll_error: string | null;
          last_event_count: number | null;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Insert: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Update: any;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
};
