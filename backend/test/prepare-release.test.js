import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

import {
  assertCompleteHistory,
  assertReleasable,
  collectCommits,
  createGit,
  determineBump,
  findPreviousRelease,
  pickPrevious
} from '../../scripts/prepare-release.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/prepare-release.mjs', import.meta.url));

/**
 * Where the release script decides the last release was, and what the next
 * one is made of.
 *
 * It used to ask `git describe --tags`, and tags here are published by hand.
 * Three releases went out without one, so the script fell back to v1.14.0,
 * recomputed 1.15.0 — a heading the CHANGELOG already carried — and refused to
 * run. Every case below is a history this repository had, or one a hotfix
 * would give it, built in a throwaway repository so the answer does not depend
 * on which tags happen to exist on the machine running the suite.
 */

const scratch = [];

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-release-'));
  scratch.push(dir);
  // One second per git call. Commits made inside the same second have no
  // defined order, and several assertions below read the order back.
  let clock = Date.UTC(2026, 0, 1) / 1000;
  const run = (...args) => {
    clock += 1;
    const when = `${clock} +0000`;
    return execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Release Test',
        GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
        GIT_COMMITTER_NAME: 'Release Test',
        GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  };
  run('init', '-q');
  const commit = (subject, body) => {
    const args = ['commit', '-q', '--allow-empty', '-m', subject];
    if (body) args.push('-m', body);
    run(...args);
    return run('rev-parse', 'HEAD');
  };
  const merge = (branch, message) => run('merge', '-q', '--no-ff', '-m', message, branch);
  const { git, tryGit } = createGit(dir);
  return { dir, run, commit, merge, git, tryGit };
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
    const tagged = repo.commit('feat: cut by hand');
    repo.run('tag', '-a', 'v2.0.0', '-m', 'v2.0.0');
    repo.commit('fix: after it');

    const previous = findPreviousRelease(repo.tryGit);
    assert.equal(previous.version, '2.0.0');
    assert.equal(previous.ref, tagged);
    assert.equal(previous.source, 'tag');
  });

  it('ignores anything that only looks like a release commit', () => {
    const repo = makeRepo();
    repo.commit('chore(release): v1.2.0');
    repo.commit('chore(release): prepare the notes');
    repo.commit('chore(release): v1.3.0-rc.1');
    repo.commit('docs: explain the process', 'mentions chore(release): v9.9.9 in the body');

    assert.equal(findPreviousRelease(repo.tryGit).version, '1.2.0');
  });

  it('answers null when there has never been a release', () => {
    const repo = makeRepo();
    repo.commit('feat: the start');
    assert.equal(findPreviousRelease(repo.tryGit), null);
  });
});

describe('choosing between two markers of the same version', () => {
  /**
   * A tag placed on the merge that carried a release, rather than on the
   * release commit — as the hand-written instructions for v1.15.0 once did.
   * Given in both orders, because the order the candidates arrive in must not
   * be what decides.
   */
  it('prefers the release commit whichever arrives first', () => {
    const tag = { version: '1.15.0', ref: 'merge', source: 'tag' };
    const commit = { version: '1.15.0', ref: 'release', source: 'release commit' };
    assert.equal(pickPrevious([tag, commit]).ref, 'release');
    assert.equal(pickPrevious([commit, tag]).ref, 'release');
  });

  it('still lets a higher version win over the release commit', () => {
    const tag = { version: '1.16.0', ref: 'merge', source: 'tag' };
    const commit = { version: '1.15.0', ref: 'release', source: 'release commit' };
    assert.equal(pickPrevious([commit, tag]).ref, 'merge');
  });

  it('answers null for no candidates', () => {
    assert.equal(pickPrevious([]), null);
  });

  /**
   * The same history end to end. The merge the tag sits on also brought work
   * the next release documents; excluding the losing tag's ancestors along
   * with the release commit's would hide it.
   */
  it('does not let a same-version tag on the merge hide the next release\'s work', () => {
    const repo = makeRepo();
    repo.commit('feat: base');
    const release = repo.commit('chore(release): v1.15.0');
    repo.run('checkout', '-q', '-b', 'history');
    repo.commit('feat: belongs to 1.16.0');
    repo.run('checkout', '-q', 'main');
    repo.merge('history', 'Merge the history branch');
    repo.run('tag', '-a', 'v1.15.0', '-m', 'v1.15.0');

    const previous = findPreviousRelease(repo.tryGit);
    assert.equal(previous.ref, release);
    assert.deepEqual(subjects(collectCommits(repo.git, previous)), ['feat: belongs to 1.16.0']);
  });
});

describe('the commits the next release is made of', () => {
  /**
   * The history of v1.16.0: a commit merged beside the release commit rather
   * than into it. Anchored on the merge, it belongs to no release; anchored on
   * the release commit, the next one lists it.
   */
  it('lists work merged beside a release commit in the release after it', () => {
    const repo = makeRepo();
    repo.commit('feat: shipped in the last release');
    repo.run('checkout', '-q', '-b', 'security');
    repo.commit('Close the three SSRF holes');
    repo.run('checkout', '-q', 'main');
    repo.commit('chore(release): v1.16.0');
    repo.merge('security', 'Merge the security branch');
    repo.commit('feat: new after the release');

    const commits = collectCommits(repo.git, findPreviousRelease(repo.tryGit));
    assert.deepEqual(subjects(commits), ['Close the three SSRF holes', 'feat: new after the release']);
    assert.equal(determineBump(commits), 'minor');
  });

  it('lists neither merges nor release commits, and nothing already released', () => {
    const repo = makeRepo();
    repo.commit('feat: in 1.0.0');
    repo.commit('chore(release): v1.0.0');
    repo.run('checkout', '-q', '-b', 'side');
    repo.commit('fix: from a side branch');
    repo.run('checkout', '-q', 'main');
    repo.commit('feat: on main');
    repo.merge('side', 'Merge the side branch');

    const commits = collectCommits(repo.git, findPreviousRelease(repo.tryGit));
    assert.deepEqual(subjects(commits), ['fix: from a side branch', 'feat: on main']);
  });

  /**
   * A hotfix released from its own branch, then merged back after a newer
   * release was cut on main. The newest release does not contain the hotfix,
   * but the hotfix's own release does — and it must not be listed twice.
   */
  it('does not list a hotfix again once its branch is merged back', () => {
    const repo = makeRepo();
    repo.commit('feat: base');
    repo.commit('chore(release): v1.17.0');
    repo.run('checkout', '-q', '-b', 'hotfix');
    repo.run('checkout', '-q', 'main');
    repo.commit('feat: big');
    repo.commit('chore(release): v1.18.0');
    repo.run('checkout', '-q', 'hotfix');
    repo.commit('fix: urgent');
    repo.commit('chore(release): v1.17.1');
    repo.run('checkout', '-q', 'main');
    repo.merge('hotfix', 'Merge the hotfix back');
    repo.commit('fix: later');

    const previous = findPreviousRelease(repo.tryGit);
    assert.equal(previous.version, '1.18.0');
    assert.deepEqual(subjects(collectCommits(repo.git, previous)), ['fix: later']);
  });
});

describe('refusing before anything is written', () => {
  it('refuses a version that is already in the CHANGELOG', () => {
    assert.throws(
      () => assertReleasable({ nextVersion: '1.18.0', currentVersion: '1.17.0', changelog: '## [1.18.0] - x' }),
      /already contains version 1\.18\.0/
    );
  });

  /** The shallow clone's 1.12.0 against a tree at 1.18.0. */
  it('refuses to move the version backwards', () => {
    assert.throws(
      () => assertReleasable({ nextVersion: '1.12.0', currentVersion: '1.18.0', changelog: '' }),
      /would be 1\.12\.0, but package\.json is already at 1\.18\.0/
    );
  });

  it('refuses to cut the version the tree already declares', () => {
    assert.throws(() => assertReleasable({ nextVersion: '1.18.0', currentVersion: '1.18.0', changelog: '' }));
  });

  it('lets a higher version through', () => {
    assert.doesNotThrow(() => assertReleasable({ nextVersion: '1.19.0', currentVersion: '1.18.0', changelog: '## [1.18.0]' }));
  });
});

describe('a release cut from a shallow clone', () => {
  let origin;

  /**
   * A tree laid out like this one, with the release commit for 1.18.0 buried
   * under enough later work that a shallow clone cuts it off.
   */
  before(() => {
    origin = makeRepo();
    const write = (relative, content) => {
      const file = path.join(origin.dir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    const manifest = (name) => `${JSON.stringify({ name, version: '1.18.0' }, null, 2)}\n`;
    const lock = (name) => `${JSON.stringify({ name, version: '1.18.0', packages: { '': { version: '1.18.0' } } }, null, 2)}\n`;
    write('scripts/prepare-release.mjs', fs.readFileSync(SCRIPT, 'utf8'));
    write('package.json', manifest('root'));
    write('backend/package.json', manifest('backend'));
    write('frontend/package.json', manifest('frontend'));
    write('backend/package-lock.json', lock('backend'));
    write('frontend/package-lock.json', lock('frontend'));
    write('frontend/src/generated/release.json', '{}\n');
    write('CHANGELOG.md', '# Changelog\n\n## [1.18.0] - 2026-09-26\n\n- earlier\n');
    origin.run('add', '-A');
    origin.commit('feat: the tree as it stood');
    origin.commit('chore(release): v1.18.0');
    for (let i = 1; i <= 12; i += 1) origin.commit(i % 4 ? `fix: change ${i}` : `feat: change ${i}`);
  });

  const cloneOf = (...flags) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-release-clone-'));
    scratch.push(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    execFileSync('git', ['clone', '-q', ...flags, `file://${origin.dir}`, dir], { stdio: 'ignore' });
    return dir;
  };

  const release = (dir) => {
    try {
      const out = execFileSync(process.execPath, ['scripts/prepare-release.mjs'], {
        cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      });
      return { ok: true, out };
    } catch (error) {
      return { ok: false, out: `${error.stdout}${error.stderr}` };
    }
  };

  const dirty = (dir) => execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
  const version = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

  it('is told to fetch the full history, and leaves every file as it was', () => {
    const dir = cloneOf('--depth', '5');
    const { tryGit } = createGit(dir);
    assert.throws(() => assertCompleteHistory(tryGit), /shallow clone/);

    const result = release(dir);
    assert.equal(result.ok, false);
    assert.match(result.out, /git fetch --unshallow/);
    assert.equal(dirty(dir), '');
    assert.equal(version(dir), '1.18.0');
  });

  /** The guard that does not depend on knowing why the anchor went missing. */
  it('refuses a downgrade without writing, whatever lost the release commit', () => {
    const dir = cloneOf();
    const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    run('config', 'user.name', 'Release Test');
    run('config', 'user.email', 'release-test@example.invalid');
    // package.json moved ahead by hand: the next release by the commits is 1.19.0.
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'root', version: '2.0.0' }, null, 2)}\n`);
    run('commit', '-q', '-am', 'chore: bump by hand');

    const result = release(dir);
    assert.equal(result.ok, false);
    assert.match(result.out, /never moves the version backwards/);
    assert.equal(dirty(dir), '');
  });

  it('cuts the release once the history is complete', () => {
    const dir = cloneOf('--depth', '5');
    execFileSync('git', ['fetch', '-q', '--unshallow'], { cwd: dir, stdio: 'ignore' });

    const result = release(dir);
    assert.equal(result.ok, true, result.out);
    assert.match(result.out, /v1\.19\.0 .* after v1\.18\.0 \(release commit\)/);
    assert.equal(version(dir), '1.19.0');
  });
});
