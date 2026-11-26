-- 切り抜き動画。ボットが枠を作った時点で pending、動画の実体を確認できたら ready になる。
-- 視聴側に出すのは ready だけ。
CREATE TABLE clips (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
  title TEXT NOT NULL,
  description TEXT,
  -- 切り抜き元（YouTube の配信アーカイブなど）
  source_url TEXT,
  source_title TEXT,
  source_start_seconds INTEGER,
  -- ボット側の識別子。同じボットが同じ値で再送しても二重登録しない
  external_id TEXT,
  video_key TEXT NOT NULL,
  poster_key TEXT,
  content_type TEXT NOT NULL,
  size_bytes INTEGER,
  duration_seconds REAL,
  width INTEGER,
  height INTEGER,
  view_count INTEGER NOT NULL DEFAULT 0,
  -- agent:<トークン名> または viewer:<email>
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE INDEX idx_clips_feed ON clips (status, published_at DESC, id DESC);
CREATE INDEX idx_clips_pending ON clips (status, created_at);
CREATE UNIQUE INDEX idx_clips_external ON clips (created_by, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE clip_tags (
  clip_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (clip_id, tag)
);

CREATE INDEX idx_clip_tags_tag ON clip_tags (tag, clip_id);

-- ボット用トークン。平文は発行時に一度だけ返し、ここには SHA-256 だけを持つ
CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
