-- Add updated_at to regions table (matches source schema, needed for sync)
ALTER TABLE regions ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now() NOT NULL;

-- Auto-update trigger
CREATE TRIGGER regions_updated_at
  BEFORE UPDATE ON regions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
