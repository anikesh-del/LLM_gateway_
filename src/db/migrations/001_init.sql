-- 001_init.sql: Initial schema for virtual API keys and request usage logging

CREATE TABLE IF NOT EXISTS api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  key_prefix    text NOT NULL,             -- first 8 chars, for display only
  key_hash      text NOT NULL UNIQUE,      -- sha256 hex of full key
  budget_paise  bigint NOT NULL CHECK (budget_paise >= 0),
  spent_paise   bigint NOT NULL DEFAULT 0 CHECK (spent_paise >= 0), -- settled + in-flight reservations
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    text NOT NULL,
  api_key_id    uuid NOT NULL REFERENCES api_keys(id),
  provider      text NOT NULL,
  model         text NOT NULL,             -- model that actually served the request
  route_reason  text NOT NULL,
  tokens_in     integer NOT NULL DEFAULT 0,
  tokens_out    integer NOT NULL DEFAULT 0,
  cost_paise    bigint  NOT NULL DEFAULT 0,
  status        text NOT NULL,             -- ok | provider_error | timeout | budget_rejected
  attempts      smallint NOT NULL DEFAULT 1,
  latency_ms    integer,
  error_code    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_key_created ON usage_logs (api_key_id, created_at DESC);
