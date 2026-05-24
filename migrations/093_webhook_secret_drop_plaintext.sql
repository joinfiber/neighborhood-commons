-- Migration 093: stop persisting plaintext webhook signing secrets.
--
-- signing_secret_encrypted (AES-256-GCM) was added for encryption-at-rest, but
-- the original plaintext signing_secret column kept being written alongside it
-- (routes/webhooks.ts passed it to create_webhook_subscription unconditionally).
-- A DB dump / backup / `SELECT *` therefore still yielded every signing secret
-- in cleartext, defeating the encryption.
--
-- This makes the column nullable and clears the plaintext for every row that
-- already has an encrypted copy. New rows created while encryption is configured
-- insert NULL plaintext (see routes/webhooks.ts). Rows WITHOUT an encrypted copy
-- (created in a dev/test config with no WEBHOOK_ENCRYPTION_KEY) keep their
-- plaintext, since resolveSigningSecret falls back to it only when encryption is
-- not configured. Idempotent.

ALTER TABLE webhook_subscriptions ALTER COLUMN signing_secret DROP NOT NULL;

UPDATE webhook_subscriptions
   SET signing_secret = NULL
 WHERE signing_secret_encrypted IS NOT NULL
   AND signing_secret IS NOT NULL;
