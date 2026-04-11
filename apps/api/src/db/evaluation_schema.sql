CREATE TABLE IF NOT EXISTS benchmark_markets (
  id TEXT PRIMARY KEY,
  benchmark_set_id TEXT NOT NULL DEFAULT 'polymarket_recent_resolved',
  title TEXT NOT NULL,
  resolution_criteria TEXT NOT NULL,
  theme TEXT NOT NULL,
  volume DOUBLE PRECISION NOT NULL DEFAULT 0,
  liquidity DOUBLE PRECISION NOT NULL DEFAULT 0,
  resolved_at TIMESTAMPTZ NOT NULL,
  resolved_value BOOLEAN NOT NULL,
  market_url TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE benchmark_markets
  ADD COLUMN IF NOT EXISTS benchmark_set_id TEXT NOT NULL DEFAULT 'polymarket_recent_resolved';

CREATE INDEX IF NOT EXISTS benchmark_markets_benchmark_set_id_resolved_at_idx
  ON benchmark_markets (benchmark_set_id, resolved_at DESC, id ASC);

CREATE TABLE IF NOT EXISTS benchmark_price_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  benchmark_market_id TEXT NOT NULL REFERENCES benchmark_markets(id) ON DELETE CASCADE,
  cutoff_at TIMESTAMPTZ NOT NULL,
  probability DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL DEFAULT 0,
  liquidity DOUBLE PRECISION NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'polymarket',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (benchmark_market_id, cutoff_at, source)
);

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  benchmark_set_id TEXT NOT NULL,
  cutoffs JSONB NOT NULL DEFAULT '[]'::jsonb,
  baselines JSONB NOT NULL DEFAULT '[]'::jsonb,
  overall_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  replay_fidelity TEXT NOT NULL DEFAULT 'approximate',
  leakage_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS evaluation_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_run_id UUID NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  benchmark_market_id TEXT NOT NULL REFERENCES benchmark_markets(id) ON DELETE CASCADE,
  baseline TEXT NOT NULL,
  cutoff_at TIMESTAMPTZ NOT NULL,
  predicted_probability DOUBLE PRECISION NOT NULL,
  outcome BOOLEAN,
  theme TEXT,
  horizon TEXT,
  source_configuration TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS evaluation_predictions_run_market_baseline_cutoff_key
  ON evaluation_predictions (
    evaluation_run_id,
    benchmark_market_id,
    baseline,
    cutoff_at
  );

CREATE TABLE IF NOT EXISTS evaluation_slice_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_run_id UUID NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  slice_key TEXT NOT NULL,
  baseline TEXT NOT NULL,
  brier_score DOUBLE PRECISION NOT NULL,
  log_loss DOUBLE PRECISION NOT NULL,
  average_absolute_error DOUBLE PRECISION NOT NULL,
  win_rate_vs_polymarket DOUBLE PRECISION,
  sample_size INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
