import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectCommits,
  createGit,
  determineBump,
  findPreviousRelease
} from '../../scripts/prepare-release.mjs';

/**
 * Where the release script decides the last release was.
 *
 * It used to ask `git describe --tags`, and tags here are published by hand.
 * Three releases went out without one, so the script fell back to v1.14.0,
 * recomputed 1.15.0 — a heading the CHANGELOG already carried — and refused to
 * run. Every case below is a history this repository actually had, built in a
 * throwaway repository so the answer does not depend on which tags happen to
 * exist on the machine running the suite.
 */

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Release Test',
  GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
  GIT_COMMITTER_NAME: 'Release Test',
  GIT_COMMITTER_EMAIL: 'release-test@example.invalid'
};

const scratch = [];

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-release-'));
  scratch.push(dir);
  const run = (...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY },
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  run('init', '-q');
  const commit = (subject, body) => {
    const args = ['commit', '-q', '--allow-empty', '-m', subject];
    if (body) args.push('-m', body);
    run(...args);
    return run('rev-parse', 'HEAD');
  };
  const { git, tryGit } = createGit(dir);
  return { run, commit, git, tryGit };
}

const subjects = (commits) => commits.map((commit) => commit.subject);

after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe('finding the release this one follows', () => {
  it('reads it from the release commit when no tag was ever published', () => {
    const repo = makeRepo();
    repo.commit('feat: first thing');
    const release = repo.commit('chore(release): v1.4.0');
    repo.commit('fix: after the release');

    const previous = findPreviousRelease(repo.tryGit);
    assert.equal(previous.version, '1.4.0');
    assert.equal(previous.ref, release);
    assert.equal(previous.source, 'release commit');
    assert.equal(previous.label, 'v1.4.0');
  });

  /** The exact failure: the only tag is releases old, the release commits are not. */
  it('does not fall back to a stale tag behind newer release commits', () => {
    const repo = makeRepo();
    repo.commit('feat: old work');
    repo.run('tag', '-a', 'v1.14.0', '-m', 'v1.14.0');
    repo.commit('feat: newer work');
    repo.commit('chore(release): v1.15.0');
    repo.commit('feat: newest work');
    const release = repo.commit('chore(release): v1.16.0');
    repo.commit('fix: pending');

    const previous = findPreviousRelease(repo.tryGit);
    assert.equal(previous.version, '1.16.0');
    assert.equal(previous.ref, release);
  });

  it('takes the tag when it names a newer version than any release commit', () => {
    const repo = makeRepo();
    repo.commit('chore(release): v1.0.0');
    repo.commit('feat: cut by hand');
    const tagged = repo.run('rev-parse', 'HEAD');
    repo.run('tag', '-a', 'v2.0.0', '-m', 'v2.0.0');
    repo.commit('fix: after it');

    const previous = findPreviousRelease(repo.tryGit);
    assert.equal(previous.version, '2.0.0');
    assert.equal(previous.ref, tagged);
    assert.equal(previous.source, 'tag');
  });

  /**
   * A tag placed on the merge that carried a release rather than on the release
   * commit — as the hand-written instructions for v1.15.0 once did. The merge
   * also brought work documented in the NEXT release, so the release commit is
   * the anchor that keeps that work out of this one.
   */
  it('prefers the release commit when a tag of the same version sits elsewhere', () => {
    const repo = makeRepo();
    repo.commit('feat: base');
    const release = repo.commit('chore(release): v1.15.0');
    repo.commit('feat: belongs to 1.16.0');
    repo.run('tag', '-a', 'v1.15.0', '-m', 'v1.15.0');

    const previous = findPreviousRelease(repo.tryGit);
    assert.equal(previous.version, '1.15.0');
    assert.equal(previous.ref, release);
    assert.equal(previous.source, 'release commit');
  });

  it('ignores anything that only looks like a release commit', () => {
    const repo = makeRepo();
    repo.commit('chore(release): v1.2.0');
    repo.commit('chore(release): prepare the notes');
    repo.commit('chore(release): v1.3.0-rc.1');
    repo.commit('docs: explain the process', 'mentions chore(release): v9.9.9 in the body');

    const previous = findPreviousRelease(repo.tryGit);
    assert.equal(previous.version, '1.2.0');
  });

  it('answers null when there has never been a release', () => {
    const repo = makeRepo();
    repo.commit('feat: the start');
    assert.equal(findPreviousRelease(repo.tryGit), null);
  });
});

describe('the commits the next release is made of', () => {
  let repo;
  let previous;

  /**
   * The history of v1.16.0: two commits were merged beside the release commit
   * rather than into it. Anchored on the merge, they belong to no release;
   * anchored on the release commit, the next one lists them.
   */
  before(() => {
    repo = makeRepo();
    repo.commit('feat: shipped in the last release');

    repo.run('checkout', '-q', '-b', 'security');
    repo.commit('Close the three SSRF holes');

    repo.run('checkout', '-q', 'main');
    repo.commit('chore(release): v1.16.0');
    repo.run('merge', '-q', '--no-ff', '-m', 'Merge the security branch', 'security');
    repo.commit('feat: new after the release');
    repo.commit('chore(release): v1.16.1');

    previous = findPreviousRelease(repo.tryGit);
  });

  it('anchors on the newest release commit', () => {
    assert.equal(previous.version, '1.16.1');
  });

  it('lists nothing already released, and no merge or release commit', () => {
    const commits = collectCommits(repo.git, previous);
    assert.deepEqual(subjects(commits), []);
  });

  /** As 1.16.1 was cut: from the 1.16.0 release commit, not the merge after it. */
  const since = (version) => ({
    version,
    ref: repo.run('log', '-1', '--format=%H', '--fixed-strings', `--grep=chore(release): v${version}`)
  });

  it('lists work merged beside a release commit in the release after it', () => {
    const commits = collectCommits(repo.git, since('1.16.0'));
    assert.deepEqual(subjects(commits), ['Close the three SSRF holes', 'feat: new after the release']);
  });

  it('bumps by the most significant change', () => {
    assert.equal(determineBump(collectCommits(repo.git, since('1.16.0'))), 'minor');
  });
});
