export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      access_grants: {
        Row: {
          created_at: string
          granted_until: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          granted_until: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          granted_until?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      admin_audit_logs: {
        Row: {
          action: string
          admin_email: string
          admin_user_id: string | null
          created_at: string
          id: string
          ip_address: string | null
          new_values: Json | null
          old_values: Json | null
          resource_id: string | null
          resource_type: string
          user_agent: string | null
        }
        Insert: {
          action: string
          admin_email: string
          admin_user_id?: string | null
          created_at?: string
          id?: string
          ip_address?: string | null
          new_values?: Json | null
          old_values?: Json | null
          resource_id?: string | null
          resource_type: string
          user_agent?: string | null
        }
        Update: {
          action?: string
          admin_email?: string
          admin_user_id?: string | null
          created_at?: string
          id?: string
          ip_address?: string | null
          new_values?: Json | null
          old_values?: Json | null
          resource_id?: string | null
          resource_type?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_audit_logs_admin_user_id_fkey"
            columns: ["admin_user_id"]
            isOneToOne: false
            referencedRelation: "admin_users"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_sessions: {
        Row: {
          admin_user_id: string
          created_at: string
          expires_at: string
          id: string
          ip_address: string | null
          session_token: string
          user_agent: string | null
        }
        Insert: {
          admin_user_id: string
          created_at?: string
          expires_at: string
          id?: string
          ip_address?: string | null
          session_token: string
          user_agent?: string | null
        }
        Update: {
          admin_user_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          ip_address?: string | null
          session_token?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_sessions_admin_user_id_fkey"
            columns: ["admin_user_id"]
            isOneToOne: false
            referencedRelation: "admin_users"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_users: {
        Row: {
          created_at: string
          email: string
          failed_login_attempts: number
          full_name: string | null
          id: string
          is_active: boolean
          last_login_at: string | null
          locked_until: string | null
          password_hash: string
          role: Database["public"]["Enums"]["admin_role"]
          two_factor_enabled: boolean
          two_factor_secret: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          failed_login_attempts?: number
          full_name?: string | null
          id?: string
          is_active?: boolean
          last_login_at?: string | null
          locked_until?: string | null
          password_hash: string
          role?: Database["public"]["Enums"]["admin_role"]
          two_factor_enabled?: boolean
          two_factor_secret?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          failed_login_attempts?: number
          full_name?: string | null
          id?: string
          is_active?: boolean
          last_login_at?: string | null
          locked_until?: string | null
          password_hash?: string
          role?: Database["public"]["Enums"]["admin_role"]
          two_factor_enabled?: boolean
          two_factor_secret?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      api_providers: {
        Row: {
          auth_secret_name: string
          base_url: string | null
          cost_per_request: number | null
          created_at: string
          display_name: string
          id: string
          is_active: boolean
          name: string
          plan_limit: number | null
          plan_type: string | null
          quota_api_endpoint: string | null
          quota_api_method: string | null
          supports_quota_api: boolean
          updated_at: string
        }
        Insert: {
          auth_secret_name: string
          base_url?: string | null
          cost_per_request?: number | null
          created_at?: string
          display_name: string
          id?: string
          is_active?: boolean
          name: string
          plan_limit?: number | null
          plan_type?: string | null
          quota_api_endpoint?: string | null
          quota_api_method?: string | null
          supports_quota_api?: boolean
          updated_at?: string
        }
        Update: {
          auth_secret_name?: string
          base_url?: string | null
          cost_per_request?: number | null
          created_at?: string
          display_name?: string
          id?: string
          is_active?: boolean
          name?: string
          plan_limit?: number | null
          plan_type?: string | null
          quota_api_endpoint?: string | null
          quota_api_method?: string | null
          supports_quota_api?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      api_quota_snapshots: {
        Row: {
          created_at: string
          id: string
          is_estimated: boolean
          plan_limit: number | null
          provider_id: string
          raw_response: Json | null
          remaining: number | null
          reset_at: string | null
          used: number
        }
        Insert: {
          created_at?: string
          id?: string
          is_estimated?: boolean
          plan_limit?: number | null
          provider_id: string
          raw_response?: Json | null
          remaining?: number | null
          reset_at?: string | null
          used?: number
        }
        Update: {
          created_at?: string
          id?: string
          is_estimated?: boolean
          plan_limit?: number | null
          provider_id?: string
          raw_response?: Json | null
          remaining?: number | null
          reset_at?: string | null
          used?: number
        }
        Relationships: [
          {
            foreignKeyName: "api_quota_snapshots_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "api_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      api_request_logs: {
        Row: {
          correlation_id: string | null
          cost_units: number | null
          created_at: string
          duration_ms: number | null
          endpoint_type: string
          error_message: string | null
          extraction_id: string | null
          failure_category: string | null
          id: string
          metadata: Json | null
          notify_me_registration_id: string | null
          provider_name: string
          request_timestamp: string
          request_url: string | null
          response_status: number | null
          search_id: string | null
          success: boolean
        }
        Insert: {
          correlation_id?: string | null
          cost_units?: number | null
          created_at?: string
          duration_ms?: number | null
          endpoint_type: string
          error_message?: string | null
          extraction_id?: string | null
          failure_category?: string | null
          id?: string
          metadata?: Json | null
          notify_me_registration_id?: string | null
          provider_name: string
          request_timestamp?: string
          request_url?: string | null
          response_status?: number | null
          search_id?: string | null
          success?: boolean
        }
        Update: {
          correlation_id?: string | null
          cost_units?: number | null
          created_at?: string
          duration_ms?: number | null
          endpoint_type?: string
          error_message?: string | null
          extraction_id?: string | null
          failure_category?: string | null
          id?: string
          metadata?: Json | null
          notify_me_registration_id?: string | null
          provider_name?: string
          request_timestamp?: string
          request_url?: string | null
          response_status?: number | null
          search_id?: string | null
          success?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "api_request_logs_extraction_id_fkey"
            columns: ["extraction_id"]
            isOneToOne: false
            referencedRelation: "price_extractions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_request_logs_notify_me_registration_id_fkey"
            columns: ["notify_me_registration_id"]
            isOneToOne: false
            referencedRelation: "notify_me_registrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_request_logs_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "searches"
            referencedColumns: ["id"]
          },
        ]
      }
      blocked_platforms: {
        Row: {
          blocked_at: string
          domain: string
          id: string
          reason: string
        }
        Insert: {
          blocked_at?: string
          domain: string
          id?: string
          reason: string
        }
        Update: {
          blocked_at?: string
          domain?: string
          id?: string
          reason?: string
        }
        Relationships: []
      }
      launch_signups: {
        Row: {
          created_at: string
          email: string
          id: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
        }
        Relationships: []
      }
      notification_events: {
        Row: {
          created_at: string
          error_message: string | null
          event_type: string
          extracted_price: number | null
          extraction_id: string | null
          id: string
          metadata: Json | null
          platform_name: string | null
          registration_id: string
          savings_amount: number | null
          search_id: string | null
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          event_type: string
          extracted_price?: number | null
          extraction_id?: string | null
          id?: string
          metadata?: Json | null
          platform_name?: string | null
          registration_id: string
          savings_amount?: number | null
          search_id?: string | null
        }
        Update: {
          created_at?: string
          error_message?: string | null
          event_type?: string
          extracted_price?: number | null
          extraction_id?: string | null
          id?: string
          metadata?: Json | null
          platform_name?: string | null
          registration_id?: string
          savings_amount?: number | null
          search_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_events_extraction_id_fkey"
            columns: ["extraction_id"]
            isOneToOne: false
            referencedRelation: "price_extractions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_events_registration_id_fkey"
            columns: ["registration_id"]
            isOneToOne: false
            referencedRelation: "notify_me_registrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_events_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "searches"
            referencedColumns: ["id"]
          },
        ]
      }
      notify_me_registrations: {
        Row: {
          created_at: string
          email: string
          email_hash: string | null
          id: string
          is_active: boolean
          last_notification_error: string | null
          last_notified_at: string | null
          metadata: Json | null
          notification_count: number
          notification_status: string
          price_threshold_percentage: number | null
          search_id: string | null
          source_airbnb_price: number | null
          source_airbnb_title: string | null
          source_airbnb_url: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          email_hash?: string | null
          id?: string
          is_active?: boolean
          last_notification_error?: string | null
          last_notified_at?: string | null
          metadata?: Json | null
          notification_count?: number
          notification_status?: string
          price_threshold_percentage?: number | null
          search_id?: string | null
          source_airbnb_price?: number | null
          source_airbnb_title?: string | null
          source_airbnb_url?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          email_hash?: string | null
          id?: string
          is_active?: boolean
          last_notification_error?: string | null
          last_notified_at?: string | null
          metadata?: Json | null
          notification_count?: number
          notification_status?: string
          price_threshold_percentage?: number | null
          search_id?: string | null
          source_airbnb_price?: number | null
          source_airbnb_title?: string | null
          source_airbnb_url?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notify_me_registrations_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "searches"
            referencedColumns: ["id"]
          },
        ]
      }
      pipeline_jobs: {
        Row: {
          backoff_until: string | null
          completed_at: string | null
          created_at: string
          duration_ms: number | null
          error_category: string | null
          error_message: string | null
          extraction_id: string | null
          id: string
          job_type: string
          max_retries: number
          metadata: Json | null
          priority: number
          retry_count: number
          search_id: string | null
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          backoff_until?: string | null
          completed_at?: string | null
          created_at?: string
          duration_ms?: number | null
          error_category?: string | null
          error_message?: string | null
          extraction_id?: string | null
          id?: string
          job_type: string
          max_retries?: number
          metadata?: Json | null
          priority?: number
          retry_count?: number
          search_id?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          backoff_until?: string | null
          completed_at?: string | null
          created_at?: string
          duration_ms?: number | null
          error_category?: string | null
          error_message?: string | null
          extraction_id?: string | null
          id?: string
          job_type?: string
          max_retries?: number
          metadata?: Json | null
          priority?: number
          retry_count?: number
          search_id?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_jobs_extraction_id_fkey"
            columns: ["extraction_id"]
            isOneToOne: false
            referencedRelation: "price_extractions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pipeline_jobs_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "searches"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_adapters: {
        Row: {
          coverage_reason: string | null
          coverage_status: string | null
          coverage_tier: string | null
          created_at: string
          date_application_strategy: string | null
          date_format: string
          date_validation_required: boolean | null
          dedicated_extractor: string | null
          deep_link_template: string
          extraction_schema_overrides: Json | null
          gate_1_passed: boolean | null
          gate_2_passed: boolean | null
          gate_3_passed: boolean | null
          id: string
          is_active: boolean
          is_ai_generated: boolean
          last_attempt_at: string | null
          last_failure_at: string | null
          last_outcome_type: string | null
          last_scored_at: string | null
          last_success_at: string | null
          last_successful_strategy: string | null
          learned_navigation_steps: Json | null
          navigation_hints: Json | null
          next_review: string | null
          occupancy_params: Json | null
          platform_domain: string
          platform_name: string
          price_selectors: Json | null
          promotion_candidate: boolean | null
          promotion_candidate_reason: string | null
          promotion_decision_at: string | null
          promotion_decision_by: string | null
          promotion_in_progress: boolean | null
          promotion_notes: string | null
          promotion_score: number | null
          promotion_snapshot: Json | null
          promotion_source_score: number | null
          promotion_started_at: string | null
          promotion_started_by: string | null
          promotion_status: string | null
          proven_deterministic: boolean | null
          reliability_score: number | null
          requires_occupancy: boolean
          retry_policy: string | null
          strategy_updated_at: string | null
          tier_reason: string | null
          tier_updated_at: string | null
          total_attempts: number
          total_failures: number
          total_successes: number
          updated_at: string
          url_parameter_rules: Json | null
          validation_rules: Json | null
        }
        Insert: {
          coverage_reason?: string | null
          coverage_status?: string | null
          coverage_tier?: string | null
          created_at?: string
          date_application_strategy?: string | null
          date_format?: string
          date_validation_required?: boolean | null
          dedicated_extractor?: string | null
          deep_link_template: string
          extraction_schema_overrides?: Json | null
          gate_1_passed?: boolean | null
          gate_2_passed?: boolean | null
          gate_3_passed?: boolean | null
          id?: string
          is_active?: boolean
          is_ai_generated?: boolean
          last_attempt_at?: string | null
          last_failure_at?: string | null
          last_outcome_type?: string | null
          last_scored_at?: string | null
          last_success_at?: string | null
          last_successful_strategy?: string | null
          learned_navigation_steps?: Json | null
          navigation_hints?: Json | null
          next_review?: string | null
          occupancy_params?: Json | null
          platform_domain: string
          platform_name: string
          price_selectors?: Json | null
          promotion_candidate?: boolean | null
          promotion_candidate_reason?: string | null
          promotion_decision_at?: string | null
          promotion_decision_by?: string | null
          promotion_in_progress?: boolean | null
          promotion_notes?: string | null
          promotion_score?: number | null
          promotion_snapshot?: Json | null
          promotion_source_score?: number | null
          promotion_started_at?: string | null
          promotion_started_by?: string | null
          promotion_status?: string | null
          proven_deterministic?: boolean | null
          reliability_score?: number | null
          requires_occupancy?: boolean
          retry_policy?: string | null
          strategy_updated_at?: string | null
          tier_reason?: string | null
          tier_updated_at?: string | null
          total_attempts?: number
          total_failures?: number
          total_successes?: number
          updated_at?: string
          url_parameter_rules?: Json | null
          validation_rules?: Json | null
        }
        Update: {
          coverage_reason?: string | null
          coverage_status?: string | null
          coverage_tier?: string | null
          created_at?: string
          date_application_strategy?: string | null
          date_format?: string
          date_validation_required?: boolean | null
          dedicated_extractor?: string | null
          deep_link_template?: string
          extraction_schema_overrides?: Json | null
          gate_1_passed?: boolean | null
          gate_2_passed?: boolean | null
          gate_3_passed?: boolean | null
          id?: string
          is_active?: boolean
          is_ai_generated?: boolean
          last_attempt_at?: string | null
          last_failure_at?: string | null
          last_outcome_type?: string | null
          last_scored_at?: string | null
          last_success_at?: string | null
          last_successful_strategy?: string | null
          learned_navigation_steps?: Json | null
          navigation_hints?: Json | null
          next_review?: string | null
          occupancy_params?: Json | null
          platform_domain?: string
          platform_name?: string
          price_selectors?: Json | null
          promotion_candidate?: boolean | null
          promotion_candidate_reason?: string | null
          promotion_decision_at?: string | null
          promotion_decision_by?: string | null
          promotion_in_progress?: boolean | null
          promotion_notes?: string | null
          promotion_score?: number | null
          promotion_snapshot?: Json | null
          promotion_source_score?: number | null
          promotion_started_at?: string | null
          promotion_started_by?: string | null
          promotion_status?: string | null
          proven_deterministic?: boolean | null
          reliability_score?: number | null
          requires_occupancy?: boolean
          retry_policy?: string | null
          strategy_updated_at?: string | null
          tier_reason?: string | null
          tier_updated_at?: string | null
          total_attempts?: number
          total_failures?: number
          total_successes?: number
          updated_at?: string
          url_parameter_rules?: Json | null
          validation_rules?: Json | null
        }
        Relationships: []
      }
      price_extractions: {
        Row: {
          assumed_adults: number | null
          assumed_children: number | null
          assumed_rooms: number | null
          confidence_score: number | null
          created_at: string
          currency: string | null
          date_validation_attempts: number | null
          dates_validated: boolean | null
          deep_link: string
          detected_checkin: string | null
          detected_checkout: string | null
          evidence_snippets: Json | null
          extracted_price: number | null
          extraction_error: string | null
          extraction_metadata: Json | null
          extraction_stage: string | null
          extraction_status: string
          final_resolved_url: string | null
          id: string
          includes_taxes_fees: boolean | null
          notify_me_registration_id: string | null
          occupancy_assumed: boolean | null
          page_content_hash: string | null
          platform_name: string
          price_type: string
          provider_used: string | null
          search_id: string | null
          search_result_id: string | null
          updated_at: string
        }
        Insert: {
          assumed_adults?: number | null
          assumed_children?: number | null
          assumed_rooms?: number | null
          confidence_score?: number | null
          created_at?: string
          currency?: string | null
          date_validation_attempts?: number | null
          dates_validated?: boolean | null
          deep_link: string
          detected_checkin?: string | null
          detected_checkout?: string | null
          evidence_snippets?: Json | null
          extracted_price?: number | null
          extraction_error?: string | null
          extraction_metadata?: Json | null
          extraction_stage?: string | null
          extraction_status?: string
          final_resolved_url?: string | null
          id?: string
          includes_taxes_fees?: boolean | null
          notify_me_registration_id?: string | null
          occupancy_assumed?: boolean | null
          page_content_hash?: string | null
          platform_name: string
          price_type?: string
          provider_used?: string | null
          search_id?: string | null
          search_result_id?: string | null
          updated_at?: string
        }
        Update: {
          assumed_adults?: number | null
          assumed_children?: number | null
          assumed_rooms?: number | null
          confidence_score?: number | null
          created_at?: string
          currency?: string | null
          date_validation_attempts?: number | null
          dates_validated?: boolean | null
          deep_link?: string
          detected_checkin?: string | null
          detected_checkout?: string | null
          evidence_snippets?: Json | null
          extracted_price?: number | null
          extraction_error?: string | null
          extraction_metadata?: Json | null
          extraction_stage?: string | null
          extraction_status?: string
          final_resolved_url?: string | null
          id?: string
          includes_taxes_fees?: boolean | null
          notify_me_registration_id?: string | null
          occupancy_assumed?: boolean | null
          page_content_hash?: string | null
          platform_name?: string
          price_type?: string
          provider_used?: string | null
          search_id?: string | null
          search_result_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "price_extractions_notify_me_registration_id_fkey"
            columns: ["notify_me_registration_id"]
            isOneToOne: false
            referencedRelation: "notify_me_registrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_extractions_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "searches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_extractions_search_result_id_fkey"
            columns: ["search_result_id"]
            isOneToOne: false
            referencedRelation: "search_results"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      search_results: {
        Row: {
          confidence_score: number | null
          created_at: string
          dates_differ: boolean | null
          id: string
          image_url: string | null
          images: Json | null
          listing_title: string | null
          listing_url: string
          match_type: string | null
          original_price: number | null
          platform_name: string
          price: number | null
          price_check_in: string | null
          price_check_out: string | null
          savings_amount: number | null
          savings_percentage: number | null
          search_id: string
          source_airbnb_image: string | null
        }
        Insert: {
          confidence_score?: number | null
          created_at?: string
          dates_differ?: boolean | null
          id?: string
          image_url?: string | null
          images?: Json | null
          listing_title?: string | null
          listing_url: string
          match_type?: string | null
          original_price?: number | null
          platform_name: string
          price?: number | null
          price_check_in?: string | null
          price_check_out?: string | null
          savings_amount?: number | null
          savings_percentage?: number | null
          search_id: string
          source_airbnb_image?: string | null
        }
        Update: {
          confidence_score?: number | null
          created_at?: string
          dates_differ?: boolean | null
          id?: string
          image_url?: string | null
          images?: Json | null
          listing_title?: string | null
          listing_url?: string
          match_type?: string | null
          original_price?: number | null
          platform_name?: string
          price?: number | null
          price_check_in?: string | null
          price_check_out?: string | null
          savings_amount?: number | null
          savings_percentage?: number | null
          search_id?: string
          source_airbnb_image?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "search_results_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "searches"
            referencedColumns: ["id"]
          },
        ]
      }
      search_stage_runs: {
        Row: {
          created_at: string
          duration_ms: number | null
          error_message: string | null
          finished_at: string | null
          id: string
          metadata: Json | null
          outcome_status: string
          search_id: string
          stage_name: string
          started_at: string
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          metadata?: Json | null
          outcome_status?: string
          search_id: string
          stage_name: string
          started_at?: string
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          metadata?: Json | null
          outcome_status?: string
          search_id?: string
          stage_name?: string
          started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "search_stage_runs_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "searches"
            referencedColumns: ["id"]
          },
        ]
      }
      search_stage_stats: {
        Row: {
          avg_duration_ms: number | null
          computed_date: string
          created_at: string
          id: string
          max_duration_ms: number | null
          min_duration_ms: number | null
          p50_duration_ms: number | null
          p80_duration_ms: number | null
          sample_count: number
          stage_name: string
          success_rate: number | null
          updated_at: string
        }
        Insert: {
          avg_duration_ms?: number | null
          computed_date?: string
          created_at?: string
          id?: string
          max_duration_ms?: number | null
          min_duration_ms?: number | null
          p50_duration_ms?: number | null
          p80_duration_ms?: number | null
          sample_count?: number
          stage_name: string
          success_rate?: number | null
          updated_at?: string
        }
        Update: {
          avg_duration_ms?: number | null
          computed_date?: string
          created_at?: string
          id?: string
          max_duration_ms?: number | null
          min_duration_ms?: number | null
          p50_duration_ms?: number | null
          p80_duration_ms?: number | null
          sample_count?: number
          stage_name?: string
          success_rate?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      searches: {
        Row: {
          airbnb_currency: string | null
          airbnb_image_url: string | null
          airbnb_images: Json | null
          airbnb_price: number | null
          airbnb_title: string | null
          airbnb_url: string
          api_error: string | null
          api_error_code: string | null
          check_in_date: string | null
          check_out_date: string | null
          created_at: string
          id: string
          last_progress_at: string | null
          nights_count: number | null
          public_demo_ok: boolean
          skip_requested: boolean
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          airbnb_currency?: string | null
          airbnb_image_url?: string | null
          airbnb_images?: Json | null
          airbnb_price?: number | null
          airbnb_title?: string | null
          airbnb_url: string
          api_error?: string | null
          api_error_code?: string | null
          check_in_date?: string | null
          check_out_date?: string | null
          created_at?: string
          id?: string
          last_progress_at?: string | null
          nights_count?: number | null
          public_demo_ok?: boolean
          skip_requested?: boolean
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          airbnb_currency?: string | null
          airbnb_image_url?: string | null
          airbnb_images?: Json | null
          airbnb_price?: number | null
          airbnb_title?: string | null
          airbnb_url?: string
          api_error?: string | null
          api_error_code?: string | null
          check_in_date?: string | null
          check_out_date?: string | null
          created_at?: string
          id?: string
          last_progress_at?: string | null
          nights_count?: number | null
          public_demo_ok?: boolean
          skip_requested?: boolean
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      admin_role: "super_admin" | "admin" | "viewer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      admin_role: ["super_admin", "admin", "viewer"],
    },
  },
} as const
