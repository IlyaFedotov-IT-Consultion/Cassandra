CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question TEXT NOT NULL,
  resolution_criteria TEXT NOT NULL,
  deadline TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  entities JSONB NOT NULL DEFAULT '[]'::jsonb,
  reference_class TEXT,
  market_symbols JSONB NOT NULL DEFAULT '[]'::jsonb,
  polymarket_market_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS watchlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  jurisdictions JSONB NOT NULL DEFAULT '[]'::jsonb,
  cadence TEXT NOT NULL,
  source_toggles JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE watchlists
  ADD COLUMN IF NOT EXISTS last_discovery JSONB;

CREATE TABLE IF NOT EXISTS candidate_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id UUID REFERENCES watchlists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  supporting_evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  cluster_key TEXT NOT NULL,
  candidate_signature JSONB NOT NULL DEFAULT '{}'::jsonb,
  promotion_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE candidate_events
  ADD COLUMN IF NOT EXISTS candidate_signature JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS evidence_items (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source_family TEXT NOT NULL,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  publisher TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL,
  summary TEXT NOT NULL,
  raw_text TEXT,
  entities JSONB NOT NULL DEFAULT '[]'::jsonb,
  claims JSONB NOT NULL DEFAULT '[]'::jsonb,
  stance TEXT NOT NULL,
  quality_signals JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS evidence_items_event_id_url_key
  ON evidence_items (event_id, url);

CREATE TABLE IF NOT EXISTS judgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  verdict_trace JSONB,
  execution_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE judgments
  ADD COLUMN IF NOT EXISTS execution_log JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS judge_opinions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  judgment_id UUID NOT NULL REFERENCES judgments(id) ON DELETE CASCADE,
  judge_name TEXT NOT NULL,
  probability DOUBLE PRECISION NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  evidence_strength TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  log_bayes_factor DOUBLE PRECISION NOT NULL,
  base_weight DOUBLE PRECISION NOT NULL,
  dependency_discount DOUBLE PRECISION NOT NULL,
  freshness_decay DOUBLE PRECISION NOT NULL,
  effective_log_odds_contribution DOUBLE PRECISION NOT NULL,
  missing_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  resolved_value BOOLEAN NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL,
  resolution_source_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS calibration_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  training_window TEXT NOT NULL,
  judge_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
  base_rate_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  market_prior_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  calibration_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  online_learning_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  weight_regime TEXT NOT NULL DEFAULT 'cold_start',
  resolved_outcome_count INTEGER NOT NULL DEFAULT 0,
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
