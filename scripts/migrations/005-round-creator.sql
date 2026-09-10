ALTER TABLE rounds ADD COLUMN creator_id TEXT;
UPDATE rounds r SET creator_id=g.creator_id FROM groups g WHERE g.id=r.group_id;
INSERT INTO round_members(round_id,user_id,display_name_snapshot,joined_at)
SELECT r.id,r.creator_id,COALESCE(u.display_name,'카카오 사용자'),r.created_at
FROM rounds r JOIN users u ON u.id=r.creator_id
ON CONFLICT (round_id,user_id) DO NOTHING;
ALTER TABLE rounds ALTER COLUMN creator_id SET NOT NULL;
ALTER TABLE rounds ADD CONSTRAINT rounds_id_creator_id_fkey
  FOREIGN KEY (id, creator_id) REFERENCES round_members(round_id, user_id)
  DEFERRABLE INITIALLY DEFERRED;
