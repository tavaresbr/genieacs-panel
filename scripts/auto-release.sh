#!/usr/bin/env bash
#
# Cut a release from the commit checked out, push it to the branch, and tag
# every release commit that has no tag yet.
#
#   scripts/auto-release.sh <branch>
#
# Run by .github/workflows/release.yml once CI is green on <branch>, from a full
# clone (prepare-release.mjs refuses a shallow one) with the CI-verified commit
# checked out. Safe to run by hand, and safe to run twice: with nothing new
# since the last release it only fills in missing tags.
#
# It never pushes over newer work. If <branch> moved past the commit being
# released, it stops without pushing: the newer commit has its own CI run, and
# the release that follows it covers everything in between.

set -euo pipefail

branch="${1:-main}"
remote="${AUTO_RELEASE_REMOTE:-origin}"
release_subject='^chore\(release\): v([0-9]+\.[0-9]+\.[0-9]+)$'
generated=(
  CHANGELOG.md
  package.json backend/package.json frontend/package.json
  backend/package-lock.json frontend/package-lock.json
  frontend/src/generated/release.json
)

say() { printf '%s\n' "$*"; }
output() { if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; fi; }

# Every release commit reachable from HEAD that has no tag on the remote gets
# one, on the release commit itself — where v1.13.1 and v1.14.0 already sit,
# and the only commit that holds exactly what its CHANGELOG section lists.
tag_releases() {
  local existing line sha subject version created=()
  existing="$(git ls-remote --tags "$remote" | sed -n 's|.*refs/tags/\([^^]*\)$|\1|p')"
  while IFS=' ' read -r sha subject; do
    [[ "$subject" =~ $release_subject ]] || continue
    version="v${BASH_REMATCH[1]}"
    grep -qxF "$version" <<<"$existing" && continue
    # -f: a local tag of that name that never reached the remote may sit
    # anywhere; the release commit is the only place this one belongs.
    git tag -f -a "$version" "$sha" -m "$version" >/dev/null
    created+=("$version")
    existing+=$'\n'"$version"
  done < <(git log --format='%H %s' --fixed-strings --grep='chore(release): v' HEAD)
  if [ "${#created[@]}" -gt 0 ]; then
    git push -q "$remote" "${created[@]/#/refs/tags/}"
    say "Tagged: ${created[*]}"
  fi
}

released="$(git rev-parse HEAD)"

if [[ "$(git log -1 --format=%s)" =~ $release_subject ]]; then
  say "HEAD is already the release commit for v${BASH_REMATCH[1]}."
  output released false
  tag_releases
  exit 0
fi

# Checked before anything is generated, so a run that stands down leaves
# nothing behind — not even a local release commit.
git fetch -q "$remote" "$branch"
if [ "$(git rev-parse FETCH_HEAD)" != "$released" ]; then
  say "${branch} moved past ${released:0:12}; not releasing it. The newer commit's own run will."
  output released false
  exit 0
fi

if ! out="$(node scripts/prepare-release.mjs 2>&1)"; then
  if grep -q 'there is nothing to release' <<<"$out"; then
    say "Nothing to release since the last release commit."
    output released false
    tag_releases
    exit 0
  fi
  printf '%s\n' "$out" >&2
  exit 1
fi
say "$out"

version="$(node -p "require('./package.json').version")"
git add -- "${generated[@]}"
git commit -q -m "chore(release): v${version}" -m "Cut automatically from ${released:0:12} once CI passed on ${branch}."

# A push rejected here means the branch moved in the seconds since the check
# above. That is a real failure worth a red run, not something to retry: the
# newer commit's own run releases everything anyway.
git push -q "$remote" "HEAD:refs/heads/${branch}"
say "Released v${version} on ${branch}."
output released true
output version "$version"
tag_releases
