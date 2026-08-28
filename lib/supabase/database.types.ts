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
    PostgrestVersion: "14.17"
  }
  public: {
    Tables: {
      account_sessions: {
        Row: {
          access_expires_at: string
          access_token_hash: string
          created_at: string
          id: string
          refresh_expires_at: string
          refresh_token_hash: string
          revoked_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_expires_at: string
          access_token_hash: string
          created_at?: string
          id?: string
          refresh_expires_at: string
          refresh_token_hash: string
          revoked_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_expires_at?: string
          access_token_hash?: string
          created_at?: string
          id?: string
          refresh_expires_at?: string
          refresh_token_hash?: string
          revoked_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      activity_submissions: {
        Row: {
          activity_id: string
          created_at: string
          expires_at: string
          failure_code: string | null
          finished_at: string | null
          id: string
          language: string
          manifest: Json
          metadata_bytes: number | null
          model_id: string
          project_id: string
          reflection: string
          source_id: string
          source_versions: Json
          state: string
          user_id: string
        }
        Insert: {
          activity_id: string
          created_at?: string
          expires_at?: string
          failure_code?: string | null
          finished_at?: string | null
          id: string
          language: string
          manifest: Json
          metadata_bytes?: number | null
          model_id: string
          project_id: string
          reflection?: string
          source_id: string
          source_versions: Json
          state?: string
          user_id: string
        }
        Update: {
          activity_id?: string
          created_at?: string
          expires_at?: string
          failure_code?: string | null
          finished_at?: string | null
          id?: string
          language?: string
          manifest?: Json
          metadata_bytes?: number | null
          model_id?: string
          project_id?: string
          reflection?: string
          source_id?: string
          source_versions?: Json
          state?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_submissions_project_id_user_id_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "activity_submissions_source_id_project_id_user_id_fkey"
            columns: ["source_id", "project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "submission_sources"
            referencedColumns: ["id", "project_id", "user_id"]
          },
        ]
      }
      assessments: {
        Row: {
          activity_id: string
          ai_assessed: boolean
          concepts: string[]
          created_at: string
          feedback: Json
          id: string
          language: string | null
          model_id: string | null
          passed: boolean
          project_id: string
          score: number
          source_current: boolean | null
          submission_id: string | null
          user_id: string
          verification_kind: string | null
        }
        Insert: {
          activity_id: string
          ai_assessed: boolean
          concepts?: string[]
          created_at?: string
          feedback: Json
          id?: string
          language?: string | null
          model_id?: string | null
          passed: boolean
          project_id: string
          score: number
          source_current?: boolean | null
          submission_id?: string | null
          user_id: string
          verification_kind?: string | null
        }
        Update: {
          activity_id?: string
          ai_assessed?: boolean
          concepts?: string[]
          created_at?: string
          feedback?: Json
          id?: string
          language?: string | null
          model_id?: string | null
          passed?: boolean
          project_id?: string
          score?: number
          source_current?: boolean | null
          submission_id?: string | null
          user_id?: string
          verification_kind?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "assessment_submission_owner_fk"
            columns: ["submission_id", "project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "activity_submissions"
            referencedColumns: ["id", "project_id", "user_id"]
          },
          {
            foreignKeyName: "assessments_project_id_user_id_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      billing_customers: {
        Row: {
          created_at: string
          stripe_customer_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          stripe_customer_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          stripe_customer_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      billing_events: {
        Row: {
          error: string | null
          event_id: string
          event_type: string
          processed_at: string | null
          received_at: string
        }
        Insert: {
          error?: string | null
          event_id: string
          event_type: string
          processed_at?: string | null
          received_at?: string
        }
        Update: {
          error?: string | null
          event_id?: string
          event_type?: string
          processed_at?: string | null
          received_at?: string
        }
        Relationships: []
      }
      command_audits: {
        Row: {
          background: boolean
          command_id: string | null
          created_at: string
          executable: string
          exit_code: number | null
          expires_at: string
          finished_at: string | null
          id: string
          origin: string
          output_encoding: string
          request_id: string
          sandbox_session_id: string
          status: string
          timeout_ms: number
          user_id: string
        }
        Insert: {
          background?: boolean
          command_id?: string | null
          created_at?: string
          executable: string
          exit_code?: number | null
          expires_at?: string
          finished_at?: string | null
          id?: string
          origin?: string
          output_encoding?: string
          request_id: string
          sandbox_session_id: string
          status: string
          timeout_ms?: number
          user_id: string
        }
        Update: {
          background?: boolean
          command_id?: string | null
          created_at?: string
          executable?: string
          exit_code?: number | null
          expires_at?: string
          finished_at?: string | null
          id?: string
          origin?: string
          output_encoding?: string
          request_id?: string
          sandbox_session_id?: string
          status?: string
          timeout_ms?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "command_audits_sandbox_session_id_user_id_fkey"
            columns: ["sandbox_session_id", "user_id"]
            isOneToOne: false
            referencedRelation: "sandbox_sessions"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      device_authorizations: {
        Row: {
          approved_at: string | null
          client_id: string
          consumed_at: string | null
          created_at: string
          device_code_hash: string
          expires_at: string
          interval_seconds: number
          last_polled_at: string | null
          status: string
          user_code_hash: string
          user_id: string | null
        }
        Insert: {
          approved_at?: string | null
          client_id: string
          consumed_at?: string | null
          created_at?: string
          device_code_hash: string
          expires_at: string
          interval_seconds?: number
          last_polled_at?: string | null
          status?: string
          user_code_hash: string
          user_id?: string | null
        }
        Update: {
          approved_at?: string | null
          client_id?: string
          consumed_at?: string | null
          created_at?: string
          device_code_hash?: string
          expires_at?: string
          interval_seconds?: number
          last_polled_at?: string | null
          status?: string
          user_code_hash?: string
          user_id?: string | null
        }
        Relationships: []
      }
      generated_activities: {
        Row: {
          created_at: string
          id: string
          manifest: Json
          user_id: string
        }
        Insert: {
          created_at?: string
          id: string
          manifest: Json
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          manifest?: Json
          user_id?: string
        }
        Relationships: []
      }
      learning_progress: {
        Row: {
          attempts: number
          completed_at: string | null
          hint_index: number
          lesson_id: string
          solution_revealed: boolean
          started_at: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          hint_index?: number
          lesson_id: string
          solution_revealed?: boolean
          started_at?: string | null
          status: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          hint_index?: number
          lesson_id?: string
          solution_revealed?: boolean
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      managed_ai_credit_allocations: {
        Row: {
          consumed_nanos: number
          grant_id: string
          request_id: string
          reserved_nanos: number
        }
        Insert: {
          consumed_nanos?: number
          grant_id: string
          request_id: string
          reserved_nanos: number
        }
        Update: {
          consumed_nanos?: number
          grant_id?: string
          request_id?: string
          reserved_nanos?: number
        }
        Relationships: [
          {
            foreignKeyName: "managed_ai_credit_allocations_grant_id_fkey"
            columns: ["grant_id"]
            isOneToOne: false
            referencedRelation: "managed_ai_credit_grants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "managed_ai_credit_allocations_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "managed_ai_reservations"
            referencedColumns: ["id"]
          },
        ]
      }
      managed_ai_credit_grants: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          original_nanos: number
          pack_id: string
          remaining_nanos: number
          status: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id: string
          original_nanos: number
          pack_id: string
          remaining_nanos: number
          status?: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          original_nanos?: number
          pack_id?: string
          remaining_nanos?: number
          status?: string
          stripe_checkout_session_id?: string
          stripe_payment_intent_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      managed_ai_overrides: {
        Row: {
          created_at: string
          reason: string | null
          unlimited: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          reason?: string | null
          unlimited?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          reason?: string | null
          unlimited?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      managed_ai_reservations: {
        Row: {
          actual_cost_nanos: number | null
          actual_input_tokens: number | null
          actual_output_tokens: number | null
          completed_at: string | null
          created_at: string
          id: string
          model: string
          period_start: string
          plan: string
          reserved_cost_nanos: number
          reserved_included_cost_nanos: number
          reserved_tokens: number
          status: string
          user_id: string
        }
        Insert: {
          actual_cost_nanos?: number | null
          actual_input_tokens?: number | null
          actual_output_tokens?: number | null
          completed_at?: string | null
          created_at?: string
          id: string
          model: string
          period_start: string
          plan: string
          reserved_cost_nanos: number
          reserved_included_cost_nanos?: number
          reserved_tokens: number
          status?: string
          user_id: string
        }
        Update: {
          actual_cost_nanos?: number | null
          actual_input_tokens?: number | null
          actual_output_tokens?: number | null
          completed_at?: string | null
          created_at?: string
          id?: string
          model?: string
          period_start?: string
          plan?: string
          reserved_cost_nanos?: number
          reserved_included_cost_nanos?: number
          reserved_tokens?: number
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      managed_ai_usage: {
        Row: {
          active_requests: number
          cost_nanos: number
          included_cost_nanos: number
          input_tokens: number
          output_tokens: number
          period_end: string
          period_start: string
          request_count: number
          reserved_cost_nanos: number
          reserved_included_cost_nanos: number
          reserved_tokens: number
          topup_cost_nanos: number
          updated_at: string
          user_id: string
        }
        Insert: {
          active_requests?: number
          cost_nanos?: number
          included_cost_nanos?: number
          input_tokens?: number
          output_tokens?: number
          period_end: string
          period_start: string
          request_count?: number
          reserved_cost_nanos?: number
          reserved_included_cost_nanos?: number
          reserved_tokens?: number
          topup_cost_nanos?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          active_requests?: number
          cost_nanos?: number
          included_cost_nanos?: number
          input_tokens?: number
          output_tokens?: number
          period_end?: string
          period_start?: string
          request_count?: number
          reserved_cost_nanos?: number
          reserved_included_cost_nanos?: number
          reserved_tokens?: number
          topup_cost_nanos?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          created_at: string
          id: string
          model_id: string | null
          ordinal: number
          parts: Json
          project_id: string
          reply_to: string | null
          request_id: string | null
          role: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id: string
          model_id?: string | null
          ordinal?: never
          parts: Json
          project_id: string
          reply_to?: string | null
          request_id?: string | null
          role: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          model_id?: string | null
          ordinal?: never
          parts?: Json
          project_id?: string
          reply_to?: string | null
          request_id?: string | null
          role?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_project_id_user_id_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "messages_reply_to_fkey"
            columns: ["project_id", "reply_to"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["project_id", "id"]
          },
        ]
      }
      portfolios: {
        Row: {
          document: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          document?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          document?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          activity_id: string | null
          created_at: string
          id: string
          imported_local_id: string | null
          language: string
          mode: string
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          activity_id?: string | null
          created_at?: string
          id?: string
          imported_local_id?: string | null
          language?: string
          mode?: string
          status?: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          activity_id?: string | null
          created_at?: string
          id?: string
          imported_local_id?: string | null
          language?: string
          mode?: string
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sandbox_cleanup_jobs: {
        Row: {
          attempts: number
          created_at: string
          id: string
          lease_token: string | null
          lease_until: string | null
          next_attempt_at: string
          observe_until: string
          outcome: string | null
          project_id: string
          reason: string
          sandbox_name: string
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          id: string
          lease_token?: string | null
          lease_until?: string | null
          next_attempt_at?: string
          observe_until: string
          outcome?: string | null
          project_id: string
          reason: string
          sandbox_name: string
          state: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attempts?: number
          created_at?: string
          id?: string
          lease_token?: string | null
          lease_until?: string | null
          next_attempt_at?: string
          observe_until?: string
          outcome?: string | null
          project_id?: string
          reason?: string
          sandbox_name?: string
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sandbox_sessions: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          ports: number[]
          preview_origin: string | null
          project_id: string
          sandbox_id: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          ports?: number[]
          preview_origin?: string | null
          project_id: string
          sandbox_id?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          ports?: number[]
          preview_origin?: string | null
          project_id?: string
          sandbox_id?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sandbox_sessions_project_id_user_id_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      source_capture_conflicts: {
        Row: {
          base_digest: string | null
          base_revision: number | null
          capture_job_id: string
          captured_content: string | null
          captured_digest: string | null
          created_at: string
          fingerprint: string
          id: string
          path: string
          project_id: string
          reason: string
          resolution_choice: string | null
          resolution_deleted: boolean | null
          resolution_fingerprint: string | null
          resolution_revision: number | null
          resolved_at: string | null
          reviewed_content: string | null
          reviewed_revision: number | null
          saved_content: string | null
          saved_revision: number
          user_id: string
        }
        Insert: {
          base_digest?: string | null
          base_revision?: number | null
          capture_job_id: string
          captured_content?: string | null
          captured_digest?: string | null
          created_at?: string
          fingerprint: string
          id?: string
          path: string
          project_id: string
          reason: string
          resolution_choice?: string | null
          resolution_deleted?: boolean | null
          resolution_fingerprint?: string | null
          resolution_revision?: number | null
          resolved_at?: string | null
          reviewed_content?: string | null
          reviewed_revision?: number | null
          saved_content?: string | null
          saved_revision: number
          user_id: string
        }
        Update: {
          base_digest?: string | null
          base_revision?: number | null
          capture_job_id?: string
          captured_content?: string | null
          captured_digest?: string | null
          created_at?: string
          fingerprint?: string
          id?: string
          path?: string
          project_id?: string
          reason?: string
          resolution_choice?: string | null
          resolution_deleted?: boolean | null
          resolution_fingerprint?: string | null
          resolution_revision?: number | null
          resolved_at?: string | null
          reviewed_content?: string | null
          reviewed_revision?: number | null
          saved_content?: string | null
          saved_revision?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "source_capture_conflicts_capture_job_id_project_id_user_id_fkey"
            columns: ["capture_job_id", "project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "source_capture_jobs"
            referencedColumns: ["id", "project_id", "user_id"]
          },
          {
            foreignKeyName: "source_capture_conflicts_project_id_user_id_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      source_capture_jobs: {
        Row: {
          acknowledgements: Json
          attempts: number
          available_at: string
          baseline: Json
          capture_complete: boolean
          capture_digest: string | null
          capture_terminal: boolean
          captured_at: string | null
          command_audit_id: string | null
          created_at: string
          failure_code: string | null
          failures: number
          has_conflicts: boolean
          id: string
          lease_token: string | null
          lease_until: string | null
          project_id: string
          purpose: string
          quiesced_at: string | null
          retry_state: string | null
          sandbox_session_id: string
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          acknowledgements?: Json
          attempts?: number
          available_at?: string
          baseline: Json
          capture_complete?: boolean
          capture_digest?: string | null
          capture_terminal?: boolean
          captured_at?: string | null
          command_audit_id?: string | null
          created_at?: string
          failure_code?: string | null
          failures?: number
          has_conflicts?: boolean
          id: string
          lease_token?: string | null
          lease_until?: string | null
          project_id: string
          purpose?: string
          quiesced_at?: string | null
          retry_state?: string | null
          sandbox_session_id: string
          state?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          acknowledgements?: Json
          attempts?: number
          available_at?: string
          baseline?: Json
          capture_complete?: boolean
          capture_digest?: string | null
          capture_terminal?: boolean
          captured_at?: string | null
          command_audit_id?: string | null
          created_at?: string
          failure_code?: string | null
          failures?: number
          has_conflicts?: boolean
          id?: string
          lease_token?: string | null
          lease_until?: string | null
          project_id?: string
          purpose?: string
          quiesced_at?: string | null
          retry_state?: string | null
          sandbox_session_id?: string
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "source_capture_command_owner_fk"
            columns: ["command_audit_id", "sandbox_session_id", "user_id"]
            isOneToOne: false
            referencedRelation: "command_audits"
            referencedColumns: ["id", "sandbox_session_id", "user_id"]
          },
          {
            foreignKeyName: "source_capture_jobs_project_id_user_id_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "source_capture_jobs_sandbox_session_id_project_id_user_id_fkey"
            columns: ["sandbox_session_id", "project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "sandbox_sessions"
            referencedColumns: ["id", "project_id", "user_id"]
          },
        ]
      }
      source_files: {
        Row: {
          content: string
          deleted: boolean
          path: string
          project_id: string
          revision: number
          updated_at: string
          user_id: string
        }
        Insert: {
          content: string
          deleted?: boolean
          path: string
          project_id: string
          revision?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          deleted?: boolean
          path?: string
          project_id?: string
          revision?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "source_files_project_id_user_id_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      submission_sources: {
        Row: {
          byte_size: number
          created_at: string
          digest: string
          files: Json
          id: string
          project_id: string
          storage_bytes: number | null
          user_id: string
        }
        Insert: {
          byte_size: number
          created_at?: string
          digest: string
          files: Json
          id?: string
          project_id: string
          storage_bytes?: number | null
          user_id: string
        }
        Update: {
          byte_size?: number
          created_at?: string
          digest?: string
          files?: Json
          id?: string
          project_id?: string
          storage_bytes?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "submission_sources_project_id_user_id_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          plan: string
          status: string
          stripe_price_id: string | null
          stripe_subscription_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          plan?: string
          status: string
          stripe_price_id?: string | null
          stripe_subscription_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          plan?: string
          status?: string
          stripe_price_id?: string | null
          stripe_subscription_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      usage_events: {
        Row: {
          created_at: string
          duration_ms: number | null
          id: string
          input_tokens: number | null
          kind: string
          model_id: string | null
          outcome: string
          output_tokens: number | null
          project_id: string | null
          request_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          id?: string
          input_tokens?: number | null
          kind: string
          model_id?: string | null
          outcome: string
          output_tokens?: number | null
          project_id?: string | null
          request_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          id?: string
          input_tokens?: number | null
          kind?: string
          model_id?: string | null
          outcome?: string
          output_tokens?: number | null
          project_id?: string | null
          request_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_events_project_id_user_id_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
    }
    Views: {
      assessment_progress: {
        Row: {
          activity_id: string | null
          attempts: number | null
          best_score: number | null
          completed: boolean | null
          concepts: string[] | null
          updated_at: string | null
          user_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      advance_sandbox_shutdown: {
        Args: { p_action: string; p_job_id: string; p_lease_token: string }
        Returns: boolean
      }
      attach_command_execution: {
        Args: {
          p_command_id: string
          p_reservation_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      attach_encoded_command: {
        Args: {
          p_command_id: string
          p_reservation_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      begin_activity_submission: {
        Args: {
          p_language: string
          p_manifest: Json
          p_model_id: string
          p_project_id: string
          p_reflection?: string
          p_submission_id: string
          p_user_id: string
        }
        Returns: Json
      }
      begin_chat_turn: {
        Args: {
          p_message_id: string
          p_model_id: string
          p_parts: Json
          p_project_id: string
          p_request_id: string
          p_retry?: boolean
          p_user_id: string
        }
        Returns: string
      }
      begin_sandbox_shutdown: {
        Args: { p_sandbox_id: string; p_user_id: string }
        Returns: string
      }
      begin_worker_invocation: {
        Args: { p_run_id: string; p_worker_name: string }
        Returns: boolean
      }
      claim_sandbox_cleanup: { Args: { p_job_id?: string }; Returns: Json }
      claim_source_capture: { Args: { p_job_id?: string }; Returns: Json }
      consume_rate_limit: {
        Args: {
          p_bucket_key: string
          p_limit: number
          p_user_id: string
          p_window_seconds: number
        }
        Returns: {
          allowed: boolean
          remaining: number
          reset_at: string
        }[]
      }
      create_project_archive: {
        Args: {
          p_archive_id: string
          p_catalog?: Json
          p_project_id: string
          p_user_id: string
        }
        Returns: Json
      }
      delete_project_archive: {
        Args: { p_archive_id: string; p_project_id: string; p_user_id: string }
        Returns: boolean
      }
      fail_activity_submission: {
        Args: { p_code: string; p_submission_id: string; p_user_id: string }
        Returns: boolean
      }
      finalize_managed_ai_usage: {
        Args: {
          p_cost_nanos: number
          p_input_tokens: number
          p_output_tokens: number
          p_request_id: string
          p_status: string
          p_user_id: string
        }
        Returns: undefined
      }
      finalize_managed_ai_usage_v2: {
        Args: {
          p_cost_nanos: number
          p_input_tokens: number
          p_output_tokens: number
          p_request_id: string
          p_status: string
          p_user_id: string
        }
        Returns: undefined
      }
      finish_command_execution: {
        Args: {
          p_exit_code?: number
          p_reservation_id: string
          p_status: string
          p_user_id: string
        }
        Returns: boolean
      }
      finish_submission_grading: {
        Args: {
          p_plan_digest: string
          p_report: Json
          p_submission_id: string
          p_user_id: string
        }
        Returns: Json
      }
      finish_worker_invocation: {
        Args: { p_run_id: string; p_succeeded: boolean; p_worker_name: string }
        Returns: boolean
      }
      prepare_submission_grading: {
        Args: { p_plan: Json; p_submission_id: string; p_user_id: string }
        Returns: Json
      }
      project_archive_import_operation: {
        Args: {
          p_action: string
          p_import_id: string
          p_input?: Json
          p_user_id: string
        }
        Returns: Json
      }
      purge_project_archive_imports: { Args: never; Returns: number }
      purge_project_archives: { Args: never; Returns: number }
      purge_source_imports: { Args: never; Returns: number }
      read_imported_project_archive: {
        Args: { p_after?: number; p_project_id: string; p_user_id: string }
        Returns: Json
      }
      read_project_archive: {
        Args: {
          p_after?: number
          p_archive_id: string
          p_project_id: string
          p_user_id: string
        }
        Returns: Json
      }
      read_submission_grading_summary: {
        Args: {
          p_project_id: string
          p_submission_id: string
          p_user_id: string
        }
        Returns: Json
      }
      read_worker_invocation_health: {
        Args: never
        Returns: {
          checked_at: string
          finished_at: string
          last_failure_at: string
          last_success_at: string
          outcome: string
          started_at: string
          worker_name: string
        }[]
      }
      reconcile_source_capture: {
        Args: {
          p_capture: Json
          p_job_id: string
          p_lease_token: string
          p_terminal?: boolean
        }
        Returns: Json
      }
      record_assessment: {
        Args: {
          p_activity_id: string
          p_ai_assessed: boolean
          p_assessment_id: string
          p_concepts: string[]
          p_feedback: Json
          p_language: string
          p_model_id: string
          p_passed: boolean
          p_project_id: string
          p_score: number
          p_user_id: string
          p_verification_kind: string
        }
        Returns: string
      }
      record_submission_assessment: {
        Args: {
          p_ai_assessed: boolean
          p_feedback: Json
          p_passed: boolean
          p_score: number
          p_submission_id: string
          p_user_id: string
          p_verification_kind: string
        }
        Returns: Json
      }
      reserve_command_execution: {
        Args: {
          p_background: boolean
          p_executable: string
          p_origin: string
          p_request_id: string
          p_session_id: string
          p_user_id: string
        }
        Returns: Json
      }
      reserve_managed_ai_usage: {
        Args: {
          p_concurrency_limit: number
          p_cost_limit_nanos: number
          p_model: string
          p_plan: string
          p_request_id: string
          p_request_limit: number
          p_reserved_cost_nanos: number
          p_reserved_tokens: number
          p_rpm_limit: number
          p_token_limit: number
          p_user_id: string
        }
        Returns: Json
      }
      reserve_managed_ai_usage_v2: {
        Args: {
          p_concurrency_limit: number
          p_included_cost_limit_nanos: number
          p_model: string
          p_period_end: string
          p_period_start: string
          p_plan: string
          p_request_id: string
          p_request_limit: number
          p_reserved_cost_nanos: number
          p_reserved_tokens: number
          p_rpm_limit: number
          p_token_limit: number
          p_user_id: string
        }
        Returns: Json
      }
      reserve_sandbox_session: {
        Args: { p_ports: number[]; p_project_id: string; p_user_id: string }
        Returns: string
      }
      resolve_source_conflict: {
        Args: {
          p_choice: string
          p_conflict_id: string
          p_content?: string
          p_project_id: string
          p_revision: number
          p_user_id: string
        }
        Returns: Json
      }
      retry_source_captures: {
        Args: { p_project_id: string; p_user_id: string }
        Returns: number
      }
      save_source_revision_batch: {
        Args: {
          p_create_only?: boolean
          p_files: Json
          p_project_id: string
          p_user_id: string
        }
        Returns: Json
      }
      settle_sandbox_cleanup: {
        Args: { p_job_id: string; p_lease_token: string; p_outcome: string }
        Returns: boolean
      }
      settle_source_capture: {
        Args: { p_action: string; p_job_id: string; p_lease_token: string }
        Returns: boolean
      }
      source_import_operation: {
        Args: {
          p_action: string
          p_import_id: string
          p_input?: Json
          p_user_id: string
        }
        Returns: Json
      }
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
