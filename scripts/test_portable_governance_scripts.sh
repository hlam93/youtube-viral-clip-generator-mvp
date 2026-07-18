#!/usr/bin/env bash
set -uo pipefail
# Regression tests for the portable governance scripts (check_commit_messages.sh,
# check_pr_title.sh) -- the two scripts every product-builder consumer also vendors
# (SYSTEM.md §13). Plain bash assertions, no test framework (SYSTEM.md §6). Commit-history
# scenarios run inside a disposable local clone so no synthetic commit ever touches this
# repository's real branch/history.

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
pass=0
fail=0

assert_exit() {
  local desc="$1" expected="$2"; shift 2
  local actual=0
  local out
  out="$("$@" 2>&1)" || actual=$?
  if [[ "$actual" -eq "$expected" ]]; then
    echo "PASS: $desc"
    pass=$((pass + 1))
  else
    echo "FAIL: $desc (expected exit $expected, got $actual)"
    echo "$out"
    fail=$((fail + 1))
  fi
}

# --- check_pr_title.sh: pure function of PR_TITLE, no git needed ---
assert_exit "valid PR title passes"  0 env PR_TITLE="feat: add thing"  bash "$repo_root/scripts/check_pr_title.sh"
assert_exit "scoped prefix passes"   0 env PR_TITLE="fix(scripts): x"  bash "$repo_root/scripts/check_pr_title.sh"
assert_exit "missing prefix fails"   1 env PR_TITLE="add thing"        bash "$repo_root/scripts/check_pr_title.sh"
assert_exit "empty title fails"      1 env PR_TITLE=""                bash "$repo_root/scripts/check_pr_title.sh"

# --- check_commit_messages.sh: needs real git history; use a disposable local clone ---
clone_dir="$(mktemp -d)"
trap 'rm -rf "$clone_dir"' EXIT
git clone --local --quiet "$repo_root" "$clone_dir"
git -C "$clone_dir" config user.email "test@example.com"
git -C "$clone_dir" config user.name "Governance Test"
orig_branch="$(git -C "$clone_dir" symbolic-ref --short HEAD)"

base_sha="$(git -C "$clone_dir" rev-parse HEAD)"

echo "test" >> "$clone_dir/README.md"
git -C "$clone_dir" add README.md
git -C "$clone_dir" commit --quiet -m "feat: valid synthetic commit for testing"
good_sha="$(git -C "$clone_dir" rev-parse HEAD)"

echo "test2" >> "$clone_dir/README.md"
git -C "$clone_dir" add README.md
git -C "$clone_dir" commit --quiet -m "this subject has no conventional prefix"
bad_sha="$(git -C "$clone_dir" rev-parse HEAD)"

assert_exit "valid commit subject passes"  0 env BASE_SHA="$base_sha" HEAD_SHA="$good_sha" bash "$clone_dir/scripts/check_commit_messages.sh"
assert_exit "invalid commit subject fails" 1 env BASE_SHA="$good_sha" HEAD_SHA="$bad_sha"  bash "$clone_dir/scripts/check_commit_messages.sh"

# Reset the branch tip back to the last valid commit first, so the invalid-subject
# commit tested above doesn't leak into this merge scenario's history range.
git -C "$clone_dir" checkout --quiet "$orig_branch"
git -C "$clone_dir" reset --hard --quiet "$good_sha"

# Side branch touches a brand-new file (not README.md) so the merge can never
# conflict regardless of what the main branch's own commits touched.
git -C "$clone_dir" checkout --quiet -b side "$good_sha"
echo "side content" > "$clone_dir/MERGE_TEST_SIDE.md"
git -C "$clone_dir" add MERGE_TEST_SIDE.md
git -C "$clone_dir" commit --quiet -m "feat: side change for merge-commit test"
git -C "$clone_dir" checkout --quiet "$orig_branch"
git -C "$clone_dir" merge --quiet --no-ff side -m "Merge branch 'side'"
merge_sha="$(git -C "$clone_dir" rev-parse HEAD)"

assert_exit "generated merge subject is exempted" 0 env BASE_SHA="$good_sha" HEAD_SHA="$merge_sha" bash "$clone_dir/scripts/check_commit_messages.sh"

echo
echo "$pass passed, $fail failed."
[[ "$fail" -eq 0 ]]
