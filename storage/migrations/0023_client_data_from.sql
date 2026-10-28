-- 0023 · Client data start date (user request, 2026-10-15): a customer organization sees no robot data recorded
-- before this IST day, in every part of the client app (missions, reports, telemetry, events, detections).
-- Works together with data_history_days: whichever limit is later applies. NULL = no start date.
-- The data itself is untouched; Arnobot staff still see all of it.

ALTER TABLE client_profiles ADD COLUMN data_from date;
