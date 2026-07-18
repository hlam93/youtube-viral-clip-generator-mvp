#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

base_sha="${BASE_SHA:-}"
head_sha="${HEAD_SHA:-HEAD}"

if [[ -z "$base_sha" ]]; then
  if git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    base_sha="$(git rev-parse HEAD~1)"
  else
    base_sha="$(git rev-parse HEAD)"
  fi
fi

all_zero_sha='^0+$'
if [[ "$base_sha" =~ $all_zero_sha ]]; then
  commit_list="$(git rev-list "$head_sha")"
else
  commit_list="$(git rev-list "${base_sha}..${head_sha}")"
fi

if [[ -z "$commit_list" ]]; then
  echo "No commits in range; commit policy check passed."
  exit 0
fi

subject_regex='^(feat|fix|docs|refactor|perf|test|chore)(\([^)]+\))?: .+'
merge_subject_regex='^Merge (branch|pull request) '
revert_subject_regex='^Revert "[^"]+"$'
failed=0

while IFS= read -r sha; do
  [[ -z "$sha" ]] && continue
  subject="$(git show -s --format=%s "$sha")"
  body="$(git show -s --format=%B "$sha")"

  # Allow VCS-generated merge/revert subjects while enforcing conventional
  # subjects for authored commits.
  if [[ "$subject" =~ $merge_subject_regex ]] || [[ "$subject" =~ $revert_subject_regex ]]; then
    continue
  fi

  if [[ ! "$subject" =~ $subject_regex ]]; then
    echo "Commit $sha has invalid subject: $subject"
    echo "Expected: <type>(optional-scope): <description>"
    echo "Allowed commit types: feat|fix|docs|refactor|perf|test|chore"
    echo "Also allowed: VCS-generated merge and revert subjects"
    failed=1
  fi

  if echo "$body" | grep -Ei '^Co-authored-by: .*(copilot|claude|gemini|chatgpt|gpt)' >/dev/null; then
    echo "Commit $sha includes an assistant co-author trailer, which is disallowed by workspace policy."
    failed=1
  fi
done <<< "$commit_list"

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo "Commit policy check passed."
