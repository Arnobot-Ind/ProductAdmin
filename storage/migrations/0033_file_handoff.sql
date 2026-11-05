-- 0033: files waiting to reach the shared bucket folder. A server whose AWS key cannot write there (a developer's
-- machine) leaves the file here; a server that can write moves it to the bucket and removes the row. Short-lived and
-- limited in size: it is a hand-off between servers, not file storage, so files still do not live in the database.
CREATE TABLE file_handoff (
  object_key   text PRIMARY KEY,
  content_type text,
  bytes        bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
