-- Create admin role enum
CREATE TYPE public.admin_role AS ENUM ('super_admin', 'admin', 'viewer');

-- Create admin_users table with hashed passwords
CREATE TABLE public.admin_users (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role admin_role NOT NULL DEFAULT 'admin',
    full_name TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMP WITH TIME ZONE,
    last_login_at TIMESTAMP WITH TIME ZONE,
    two_factor_secret TEXT,
    two_factor_enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create admin_sessions table
CREATE TABLE public.admin_sessions (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    admin_user_id UUID NOT NULL REFERENCES public.admin_users(id) ON DELETE CASCADE,
    session_token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create API providers table
CREATE TABLE public.api_providers (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    base_url TEXT,
    auth_secret_name TEXT NOT NULL,
    supports_quota_api BOOLEAN NOT NULL DEFAULT false,
    quota_api_endpoint TEXT,
    quota_api_method TEXT DEFAULT 'GET',
    plan_type TEXT DEFAULT 'monthly',
    plan_limit INTEGER,
    cost_per_request NUMERIC DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create API quota snapshots table
CREATE TABLE public.api_quota_snapshots (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    provider_id UUID NOT NULL REFERENCES public.api_providers(id) ON DELETE CASCADE,
    used INTEGER NOT NULL DEFAULT 0,
    remaining INTEGER,
    plan_limit INTEGER,
    reset_at TIMESTAMP WITH TIME ZONE,
    is_estimated BOOLEAN NOT NULL DEFAULT false,
    raw_response JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create API request logs table for tracking all external API calls
CREATE TABLE public.api_request_logs (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    provider_name TEXT NOT NULL,
    endpoint_type TEXT NOT NULL,
    request_url TEXT,
    request_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    response_status INTEGER,
    duration_ms INTEGER,
    success BOOLEAN NOT NULL DEFAULT false,
    failure_category TEXT,
    cost_units NUMERIC DEFAULT 1,
    search_id UUID REFERENCES public.searches(id) ON DELETE SET NULL,
    extraction_id UUID REFERENCES public.price_extractions(id) ON DELETE SET NULL,
    correlation_id TEXT,
    error_message TEXT,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create admin audit logs table
CREATE TABLE public.admin_audit_logs (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    admin_user_id UUID REFERENCES public.admin_users(id) ON DELETE SET NULL,
    admin_email TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    old_values JSONB,
    new_values JSONB,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create job queue table for pipeline visibility
CREATE TABLE public.pipeline_jobs (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    search_id UUID REFERENCES public.searches(id) ON DELETE CASCADE,
    extraction_id UUID REFERENCES public.price_extractions(id) ON DELETE SET NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    backoff_until TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    error_category TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_ms INTEGER,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_quota_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_request_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_jobs ENABLE ROW LEVEL SECURITY;

-- RLS policies: No public access to admin tables (only service role can access)
CREATE POLICY "No public access to admin_users"
ON public.admin_users FOR ALL
USING (false);

CREATE POLICY "No public access to admin_sessions"
ON public.admin_sessions FOR ALL
USING (false);

CREATE POLICY "No public access to admin_audit_logs"
ON public.admin_audit_logs FOR ALL
USING (false);

-- API providers readable by all authenticated users (but not editable)
CREATE POLICY "API providers are readable"
ON public.api_providers FOR SELECT
USING (true);

CREATE POLICY "No public insert on api_providers"
ON public.api_providers FOR INSERT
WITH CHECK (false);

CREATE POLICY "No public update on api_providers"
ON public.api_providers FOR UPDATE
USING (false);

CREATE POLICY "No public delete on api_providers"
ON public.api_providers FOR DELETE
USING (false);

-- API quota snapshots readable by all
CREATE POLICY "Quota snapshots are readable"
ON public.api_quota_snapshots FOR SELECT
USING (true);

CREATE POLICY "No public insert on quota snapshots"
ON public.api_quota_snapshots FOR INSERT
WITH CHECK (false);

-- API request logs - no public access
CREATE POLICY "No public access to request logs"
ON public.api_request_logs FOR ALL
USING (false);

-- Pipeline jobs - no public access
CREATE POLICY "No public access to pipeline jobs"
ON public.pipeline_jobs FOR ALL
USING (false);

-- Create indexes for performance
CREATE INDEX idx_admin_sessions_token ON public.admin_sessions(session_token);
CREATE INDEX idx_admin_sessions_expires ON public.admin_sessions(expires_at);
CREATE INDEX idx_api_quota_snapshots_provider ON public.api_quota_snapshots(provider_id, created_at DESC);
CREATE INDEX idx_api_request_logs_provider ON public.api_request_logs(provider_name, created_at DESC);
CREATE INDEX idx_api_request_logs_search ON public.api_request_logs(search_id);
CREATE INDEX idx_api_request_logs_extraction ON public.api_request_logs(extraction_id);
CREATE INDEX idx_api_request_logs_timestamp ON public.api_request_logs(request_timestamp DESC);
CREATE INDEX idx_admin_audit_logs_admin ON public.admin_audit_logs(admin_user_id, created_at DESC);
CREATE INDEX idx_admin_audit_logs_action ON public.admin_audit_logs(action, created_at DESC);
CREATE INDEX idx_pipeline_jobs_status ON public.pipeline_jobs(status, created_at DESC);
CREATE INDEX idx_pipeline_jobs_search ON public.pipeline_jobs(search_id);

-- Update triggers
CREATE TRIGGER update_admin_users_updated_at
BEFORE UPDATE ON public.admin_users
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_api_providers_updated_at
BEFORE UPDATE ON public.api_providers
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_pipeline_jobs_updated_at
BEFORE UPDATE ON public.pipeline_jobs
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Seed initial admin user (password: AdminTemp123! - MUST BE CHANGED)
-- Password hash for 'AdminTemp123!' using bcrypt
INSERT INTO public.admin_users (email, password_hash, role, full_name)
VALUES ('admin@arivioo.com', '$2a$10$rQnMRLBY.7JDjYC5FMnGWO5qgzd/x5OxBsXKqD.PMTGhXZR5.XVXW', 'super_admin', 'System Admin');

-- Seed API providers
INSERT INTO public.api_providers (name, display_name, auth_secret_name, supports_quota_api, plan_type, cost_per_request) VALUES
('serpapi', 'SerpAPI', 'SERPAPI_API_KEY', true, 'monthly', 1),
('firecrawl', 'Firecrawl', 'FIRECRAWL_API_KEY', false, 'monthly', 1),
('firecrawl_1', 'Firecrawl (Key 1)', 'FIRECRAWL_API_KEY_1', false, 'monthly', 1),
('zyte', 'Zyte', 'ZYTE_API_KEY', false, 'monthly', 1),
('browserless', 'Browserless', 'BROWSERLESS_API_KEY', false, 'monthly', 1);