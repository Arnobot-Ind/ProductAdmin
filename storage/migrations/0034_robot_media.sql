-- 0034: a robot can have its own photos and 360° series. A robot without them shows its base model's.
ALTER TABLE product_media ADD COLUMN robot_id text REFERENCES robots(robot_id);
ALTER TABLE product_media DROP CONSTRAINT product_media_owner_check;
ALTER TABLE product_media ADD CONSTRAINT product_media_owner_check CHECK (num_nonnulls(product_id, attachment_id, software_product_id, robot_id) = 1);
CREATE INDEX product_media_robot_idx ON product_media (robot_id, kind, position, created_at) WHERE deleted_at IS NULL AND robot_id IS NOT NULL;
