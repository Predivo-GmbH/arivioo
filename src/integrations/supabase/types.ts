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
      platform_adapters: {
        Row: {
          created_at: string
          date_format: string
          deep_link_template: string
          extraction_schema_overrides: Json | null
          id: string
          is_active: boolean
          is_ai_generated: boolean
          navigation_hints: Json | null
          occupancy_params: Json | null
          platform_domain: string
          platform_name: string
          price_selectors: Json | null
          reliability_score: number | null
          requires_occupancy: boolean
          updated_at: string
          url_parameter_rules: Json | null
          validation_rules: Json | null
        }
        Insert: {
          created_at?: string
          date_format?: string
          deep_link_template: string
          extraction_schema_overrides?: Json | null
          id?: string
          is_active?: boolean
          is_ai_generated?: boolean
          navigation_hints?: Json | null
          occupancy_params?: Json | null
          platform_domain: string
          platform_name: string
          price_selectors?: Json | null
          reliability_score?: number | null
          requires_occupancy?: boolean
          updated_at?: string
          url_parameter_rules?: Json | null
          validation_rules?: Json | null
        }
        Update: {
          created_at?: string
          date_format?: string
          deep_link_template?: string
          extraction_schema_overrides?: Json | null
          id?: string
          is_active?: boolean
          is_ai_generated?: boolean
          navigation_hints?: Json | null
          occupancy_params?: Json | null
          platform_domain?: string
          platform_name?: string
          price_selectors?: Json | null
          reliability_score?: number | null
          requires_occupancy?: boolean
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
          deep_link: string
          evidence_snippets: Json | null
          extracted_price: number | null
          extraction_error: string | null
          extraction_metadata: Json | null
          extraction_stage: string | null
          extraction_status: string
          final_resolved_url: string | null
          id: string
          includes_taxes_fees: boolean | null
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
          deep_link: string
          evidence_snippets?: Json | null
          extracted_price?: number | null
          extraction_error?: string | null
          extraction_metadata?: Json | null
          extraction_stage?: string | null
          extraction_status?: string
          final_resolved_url?: string | null
          id?: string
          includes_taxes_fees?: boolean | null
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
          deep_link?: string
          evidence_snippets?: Json | null
          extracted_price?: number | null
          extraction_error?: string | null
          extraction_metadata?: Json | null
          extraction_stage?: string | null
          extraction_status?: string
          final_resolved_url?: string | null
          id?: string
          includes_taxes_fees?: boolean | null
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
      searches: {
        Row: {
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
      [_ in never]: never
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
    Enums: {},
  },
} as const
