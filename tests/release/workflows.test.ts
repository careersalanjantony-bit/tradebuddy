import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The public repository's workflows: safe by construction. CI has no secrets and read-only access; only
 * the tagger may write, and only a tag, only after CI passed for a push to main in this repository.
 */

const dir = join(__dirname, '../../.github/workflows');
const text = (f: string) => readFileSync(join(dir, f), 'utf8');
/** YAML → JSON with python3 (PyYAML), so the test needs no extra npm package */
function yaml(f: string): any {
  const r = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', join(dir, f)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}
const on = (w: any) => w.on ?? w[true as never];
const hasYaml = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' }).status === 0;

describe('public workflows', () => {
  for (const f of ['ci.yml', 'release-tag.yml']) {
    it.skipIf(!hasYaml)(`${f}: every action pinned to a full commit SHA; read-only by default; no pull_request_target`, () => {
      const t = text(f);
      const uses = [...t.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
      expect(yaml(f).permissions).toEqual({ contents: 'read' });
      expect(t).not.toMatch(/pull_request_target/);
    });
  }

  it.skipIf(!hasYaml)('CI: pull requests and main only, no secrets, credentials not kept, the "checks" job the pipeline waits for', () => {
    const w = yaml('ci.yml');
    expect(Object.keys(on(w)).sort()).toEqual(['pull_request', 'push']);
    expect(on(w).push.branches).toEqual(['main']);
    expect(text('ci.yml')).not.toMatch(/secrets\./);
    expect(w.jobs.checks.name).toBe('checks');
    const steps = w.jobs.checks.steps.map((s: any) => s.run ?? s.uses).join('\n');
    for (const must of ['npm ci --ignore-scripts', 'npm run typecheck', 'npm run server:typecheck', 'npx vitest run', 'npm run build', 'npm run server:build', '--version-info', 'scripts/release/gate.mjs', 'npm run smoke']) expect(steps).toContain(must);
    expect(w.jobs.checks.steps[0].with['persist-credentials']).toBe(false);
    // the deploy tests also run as root (what Systems Manager does), last because they run as root
    const last = w.jobs.checks.steps.at(-1).run as string;
    expect(last).toMatch(/^sudo env .*TB_REQUIRE_ROOT_TESTS=1 .*vitest run tests\/release\/deployScript\.test\.ts$/);
  });

  it.skipIf(!hasYaml)('tagger: only after a successful CI run of a push to main in this repository; it can write tags, nothing else', () => {
    const w = yaml('release-tag.yml');
    expect(on(w)).toEqual({ workflow_run: { workflows: ['CI'], types: ['completed'], branches: ['main'] } });
    const job = w.jobs.tag;
    for (const c of ["github.repository == 'careersalanjantony-bit/tradebuddy'", "github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.event == 'push'", "github.event.workflow_run.head_branch == 'main'"]) expect(job.if).toContain(c);
    expect(job.permissions).toEqual({ contents: 'write' });
    const run = job.steps.map((s: any) => s.run ?? '').join('\n');
    expect(run).toContain('git merge-base --is-ancestor "$SHA" origin/main');
    expect(run).toContain('node scripts/release/gate.mjs --tag "$SHA"');
    expect(run).toMatch(/exists already — tags never move/);
    expect(run).not.toMatch(/--force|push -f|tag -f/);
    expect(w.concurrency).toEqual({ group: 'release-tag', 'cancel-in-progress': false });
  });
});
