/**
 * Unit tests for the trust tier resolution logic.
 *
 * The resolveAgentTrustTier() function is a pure function that doesn't need
 * a DB connection, so we inline the logic here to avoid DATABASE_URL dependency.
 *
 * Run: npx tsx src/tests/trustTier.test.ts
 */

type TrustTier = 'tier0' | 'tier1' | 'tier2' | 'tier3';

interface AgentLike {
  status: string | null | undefined;
  reputationScore: string | null | undefined;
  tasksCompleted: number | null | undefined;
}

// Mirror of resolveAgentTrustTier() from src/lib/trustTier.ts
function resolveAgentTrustTier(agent: AgentLike): TrustTier {
  if (agent.status !== 'verified') {
    return 'tier0';
  }

  const repScore = parseFloat(agent.reputationScore ?? '0');
  const tasksCompleted = agent.tasksCompleted ?? 0;

  if (repScore >= 4.0 && tasksCompleted >= 20) {
    return 'tier3';
  }

  if (repScore >= 2.0 && tasksCompleted >= 5) {
    return 'tier2';
  }

  return 'tier1';
}

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS [${label}]`);
    passed++;
  } else {
    console.error(`  ✗ FAIL [${label}]${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

console.log('\nTrust Tier resolution tests\n');

// --- Tier 0: unverified ---
assert('tier0: unverified status',
  resolveAgentTrustTier({ status: 'unverified', reputationScore: '5', tasksCompleted: 100 }) === 'tier0');
assert('tier0: suspended status',
  resolveAgentTrustTier({ status: 'suspended', reputationScore: '5', tasksCompleted: 100 }) === 'tier0');
assert('tier0: null status',
  resolveAgentTrustTier({ status: null, reputationScore: '5', tasksCompleted: 100 }) === 'tier0');
assert('tier0: undefined status',
  resolveAgentTrustTier({ status: undefined, reputationScore: '5', tasksCompleted: 100 }) === 'tier0');

// --- Tier 1: verified but low rep or few tasks ---
assert('tier1: verified, rep=0, tasks=0',
  resolveAgentTrustTier({ status: 'verified', reputationScore: '0', tasksCompleted: 0 }) === 'tier1');
assert('tier1: verified, rep=1.9, tasks=10 (rep below threshold)',
  resolveAgentTrustTier({ status: 'verified', reputationScore: '1.9', tasksCompleted: 10 }) === 'tier1');
assert('tier1: verified, rep=2.0, tasks=4 (tasks below threshold)',
  resolveAgentTrustTier({ status: 'verified', reputationScore: '2.0', tasksCompleted: 4 }) === 'tier1');
assert('tier1: verified, rep=3.9, tasks=0',
  resolveAgentTrustTier({ status: 'verified', reputationScore: '3.9', tasksCompleted: 0 }) === 'tier1');
assert('tier1: verified, rep=null, tasks=null',
  resolveAgentTrustTier({ status: 'verified', reputationScore: null, tasksCompleted: null }) === 'tier1');

// --- Tier 2: verified, rep>=2.0, tasks>=5, but below tier3 ---
assert('tier2: verified, rep=2.0, tasks=5 (exact boundary)',
  resolveAgentTrustTier({ status: 'verified', reputationScore: '2.0', tasksCompleted: 5 }) === 'tier2');
assert('tier2: verified, rep=3.5, tasks=10',
  resolveAgentTrustTier({ status: 'verified', reputationScore: '3.5', tasksCompleted: 10 }) === 'tier2');
assert('tier2: verified, rep=3.9, tasks=19 (just below tier3)',
  resolveAgentTrustTier({ status: 'verified', reputationScore: '3.9', tasksCompleted: 19 }) === 'tier2');
assert('tier2: verified, rep=4.0, tasks=19 (rep ok but tasks below tier3)',
  resolveAgentTrustTier({ status: 'verified', reputationScore: '4.0', tasksCompleted: 19 }) === 'tier2');
assert('tier2: verified, rep=3.9, tasks=20 (tasks ok but rep below tier3)',
  resolveAgentTrustTier({ status: 'verified', reputationScore: '3.9', tasksCompleted: 20 }) === 'tier2');

// --- Tier 3: verified, rep>=4.0, tasks>=20 ---
assert('tier3: verified, rep=4.0, tasks=20 (exact tier3 boundary)',
  resolveAgentTrustTier({ status: 'verified', reputationScore: '4.0', tasksCompleted: 20 }) === 'tier3');
assert('tier3: verified, rep=5.0, tasks=100',
  resolveAgentTrustTier({ status: 'verified', reputationScore: '5.0', tasksCompleted: 100 }) === 'tier3');
assert('tier3: verified, rep=4.5, tasks=20',
  resolveAgentTrustTier({ status: 'verified', reputationScore: '4.5', tasksCompleted: 20 }) === 'tier3');

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
