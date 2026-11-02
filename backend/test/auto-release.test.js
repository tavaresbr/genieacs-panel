import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The script the Release workflow runs once CI is green on `main`.
 *
 * Exercised for real, against a bare repository standing in for GitHub: what
 * matters is what ends up on the remote — the release commit, the tags, and
 * nothing pushed over newer work — and a mock of git would only prove that the
 * script calls git.
 */

const SCRIPTS = fileURLToPath(new URL('../../scripts/', import.meta.url));
const scratch = [];

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Release Test',
  GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
  GIT_COMMITTER_NAME: 'Release Test',
  GIT_COMMITTER_EMAIL: 'release-test@example.invalid'
};

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

let clock = Date.UTC(2026, 0, 1) / 1000;
function gitIn(dir) {
  return (...args) => {
    clock += 1;
    return execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...IDENTITY, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` },
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  };
}

const manifest = (name, version) => `${JSON.stringify({ name, version }, null, 2)}\n`;
const lock = (name, version) => `${JSON.stringify({ name, version, packages: { '': { version } } }, null, 2)}\n`;

/**
 * A remote whose history has the shape this one has: two releases, only the
 * first of them tagged, and new work on top.
 */
function makeRemote() {
  const remote = tmp('auto-release-remote-');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);

  const seed = tmp('auto-release-seed-');
  const git = gitIn(seed);
  git('init', '-q');
  git('remote', 'add', 'origin', remote);
  const write = (relative, content) => {
    const file = path.join(seed, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const layout = (version, changelog) => {
    write('package.json', manifest('root', version));
    write('backend/package.json', manifest('backend', version));
    write('frontend/package.json', manifest('frontend', version));
    write('backend/package-lock.json', lock('backend', version));
    write('frontend/package-lock.json', lock('frontend', version));
    write('frontend/src/generated/release.json', '{}\n');
    write('CHANGELOG.md', `# Changelog\n\n${changelog}`);
  };
  for (const file of ['prepare-release.mjs', 'auto-release.sh']) {
    write(`scripts/${file}`, fs.readFileSync(path.join(SCRIPTS, file), 'utf8'));
  }
  fs.chmodSync(path.join(seed, 'scripts/auto-release.sh'), 0o755);

  layout('1.0.0', '## [1.0.0] - 2026-01-01\n\n- first\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat: the start');
  git('commit', '-q', '--allow-empty', '-m', 'chore(release): v1.0.0');
  const v100 = git('rev-parse', 'HEAD');
  git('tag', '-a', 'v1.0.0', '-m', 'v1.0.0');

  git('commit', '-q', '--allow-empty', '-m', 'fix: a repair');
  layout('1.0.1', '## [1.0.1] - 2026-01-02\n\n- a repair\n\n## [1.0.0] - 2026-01-01\n\n- first\n');
  git('commit', '-q', '-am', 'chore(release): v1.0.1');
  const v101 = git('rev-parse', 'HEAD');

  git('commit', '-q', '--allow-empty', '-m', 'feat: something new');
  const pending = git('rev-parse', 'HEAD');
  git('push', '-q', 'origin', 'main', 'v1.0.0');

  return { remote, v100, v101, pending };
}

function cloneOf(remote) {
  const dir = tmp('auto-release-clone-');
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', remote, dir], { stdio: 'ignore' });
  return dir;
}

function autoRelease(dir) {
  const outputs = path.join(tmp('auto-release-out-'), 'github-output');
  fs.writeFileSync(outputs, '');
  try {
    const out = execFileSync('bash', ['scripts/auto-release.sh', 'main'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...IDENTITY, GITHUB_OUTPUT: outputs },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, out, outputs: fs.readFileSync(outputs, 'utf8') };
  } catch (error) {
    return { ok: false, out: `${error.stdout}${error.stderr}`, outputs: fs.readFileSync(outputs, 'utf8') };
  }
}

/** What the remote holds: main's head and every tag, each to the commit it names. */
function remoteState(remote) {
  const git = gitIn(remote);
  const tags = {};
  for (const line of git('for-each-ref', '--format=%(refname:short) %(*objectname)', 'refs/tags').split('\n').filter(Boolean)) {
    const [name, sha] = line.split(' ');
    tags[name] = sha;
  }
  return {
    head: git('rev-parse', 'main'),
    headSubject: git('log', '-1', '--format=%s', 'main'),
    headParent: git('rev-parse', 'main^'),
    tags
  };
}

after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the release the workflow cuts', () => {
  it('releases what is pending, pushes it, and tags every release that had no tag', () => {
    const { remote, v100, v101, pending } = makeRemote();
    const dir = cloneOf(remote);

    const result = autoRelease(dir);
    assert.equal(result.ok, true, result.out);
    assert.match(result.out, /Released v1\.1\.0 on main/);
    assert.match(result.outputs, /^released=true$/m);
    assert.match(result.outputs, /^version=1\.1\.0$/m);

    const state = remoteState(remote);
    assert.equal(state.headSubject, 'chore(release): v1.1.0');
    assert.equal(state.headParent, pending, 'released on top of the commit CI verified');
    assert.deepEqual(state.tags, {
      'v1.0.0': v100,
      'v1.0.1': v101,
      'v1.1.0': state.head
    });

    const version = JSON.parse(execFileSync('git', ['--git-dir', remote, 'show', 'main:package.json'], { encoding: 'utf8' })).version;
    assert.equal(version, '1.1.0');
  });

  it('does nothing the second time but confirm the tags are there', () => {
    const { remote } = makeRemote();
    autoRelease(cloneOf(remote));
    const before = remoteState(remote);

    const result = autoRelease(cloneOf(remote));
    assert.equal(result.ok, true, result.out);
    assert.match(result.out, /already the release commit for v1\.1\.0/);
    assert.match(result.outputs, /^released=false$/m);
    assert.deepEqual(remoteState(remote), before);
  });

  /**
   * CI verified one commit; by the time the release runs, another merge has
   * landed. Releasing the verified commit would push over it, and releasing
   * the new head would release something CI has not passed yet. The new
   * head's own run is the one that releases.
   */
  it('stands down when main has moved past the verified commit, leaving nothing behind', () => {
    const { remote, pending } = makeRemote();
    const verified = cloneOf(remote);

    const other = cloneOf(remote);
    gitIn(other)('commit', '-q', '--allow-empty', '-m', 'fix: merged meanwhile');
    gitIn(other)('push', '-q', 'origin', 'main');
    const moved = remoteState(remote).head;

    const result = autoRelease(verified);
    assert.equal(result.ok, true, result.out);
    assert.match(result.out, /moved past/);
    assert.match(result.outputs, /^released=false$/m);
    assert.equal(remoteState(remote).head, moved);
    assert.equal(gitIn(verified)('rev-parse', 'HEAD'), pending, 'no local release commit left behind');
    assert.equal(gitIn(verified)('status', '--porcelain'), '');
  });

  it('puts a missing tag on the release commit even when a stray local tag points elsewhere', () => {
    const { remote, v101 } = makeRemote();
    const dir = cloneOf(remote);
    gitIn(dir)('tag', '-a', 'v1.0.1', 'HEAD~3', '-m', 'stray');

    const result = autoRelease(dir);
    assert.equal(result.ok, true, result.out);
    assert.equal(remoteState(remote).tags['v1.0.1'], v101);
  });

  it('fails loudly, without pushing, when the release itself cannot be cut', () => {
    const { remote } = makeRemote();
    const dir = cloneOf(remote);
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.1.0] - taken\n');
    gitIn(dir)('commit', '-q', '-am', 'docs: claim the next heading by hand');
    gitIn(dir)('push', '-q', 'origin', 'main');
    const before = remoteState(remote);

    const result = autoRelease(dir);
    assert.equal(result.ok, false);
    assert.match(result.out, /already contains version 1\.1\.0/);
    assert.deepEqual(remoteState(remote), before);
  });
});
