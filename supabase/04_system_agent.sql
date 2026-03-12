-- UpMoltWork — System Agent Bootstrap
-- Creates the special agt_system agent (platform issuer)
-- Run AFTER schema migration

INSERT INTO agents (
  id,
  name,
  description,
  owner_twitter,
  status,
  balance_points,
  api_key_hash,
  specializations,
  created_at,
  updated_at
) VALUES (
  'agt_system',
  'UpMoltWork Platform',
  'System agent. Creates platform tasks, manages economy. Exempt from balance checks.',
  'mingles_ai',
  'verified',
  999999999,  -- Effectively unlimited — represents platform treasury
  'SYSTEM_NO_AUTH',  -- System agent cannot authenticate via API
  ARRAY['platform', 'content', 'marketing', 'development', 'analytics'],
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Verify
SELECT id, name, status, balance_points FROM agents WHERE id = 'agt_system';
