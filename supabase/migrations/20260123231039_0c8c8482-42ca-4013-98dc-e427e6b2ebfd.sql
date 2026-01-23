-- Add is_new flag to platform_adapters for newly discovered platforms
ALTER TABLE platform_adapters 
ADD COLUMN IF NOT EXISTS is_new BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- Set promotion_score to -1 for new platforms (will be at end of list)
COMMENT ON COLUMN platform_adapters.is_new IS 'Flag for newly discovered platforms that have not been reviewed';