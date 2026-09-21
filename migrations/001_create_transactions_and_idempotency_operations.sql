CREATE TABLE transactions (
  id UUID PRIMARY KEY,
  amount BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  description VARCHAR(200) NOT NULL,
  provider_transaction_id TEXT NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT transactions_amount_minor_units_check
    CHECK (amount > 0 AND amount <= 9007199254740991),
  CONSTRAINT transactions_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT transactions_description_check
    CHECK (
      char_length(description) BETWEEN 1 AND 200
      AND description = btrim(description)
    ),
  CONSTRAINT transactions_status_check
    CHECK (status = 'approved'),
  CONSTRAINT transactions_provider_id_check
    CHECK (char_length(provider_transaction_id) > 0)
);

CREATE INDEX transactions_created_at_id_idx
  ON transactions (created_at DESC, id DESC);

CREATE TABLE idempotency_operations (
  idempotency_key VARCHAR(128) PRIMARY KEY,
  request_fingerprint CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  transaction_id UUID NULL REFERENCES transactions(id),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT idempotency_operations_fingerprint_check
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_operations_status_check
    CHECK (status IN ('processing', 'completed')),
  CONSTRAINT idempotency_operations_result_check
    CHECK (
      (status = 'processing' AND transaction_id IS NULL)
      OR
      (status = 'completed' AND transaction_id IS NOT NULL)
    ),
  CONSTRAINT idempotency_operations_timestamps_check
    CHECK (updated_at >= created_at),
  CONSTRAINT idempotency_operations_transaction_unique
    UNIQUE (transaction_id)
);
