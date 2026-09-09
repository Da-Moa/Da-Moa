ALTER TABLE rounds ADD COLUMN creator_id TEXT;
UPDATE rounds r SET creator_id=g.creator_id FROM groups g WHERE g.id=r.group_id;
ALTER TABLE rounds ALTER COLUMN creator_id SET NOT NULL;
ALTER TABLE rounds ADD CONSTRAINT rounds_id_creator_id_fkey
  FOREIGN KEY (id, creator_id) REFERENCES round_members(round_id, user_id)
  DEFERRABLE INITIALLY DEFERRED;
