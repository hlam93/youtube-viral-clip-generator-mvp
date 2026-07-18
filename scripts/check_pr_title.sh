#!/usr/bin/env bash
set -euo pipefail

title="${PR_TITLE:-}"
if [[ -z "$title" ]]; then
  echo "PR_TITLE is required."
  exit 1
fi

title_regex='^(feat|fix|docs|refactor|perf|test|chore)(\([^)]+\))?: .+'
if [[ ! "$title" =~ $title_regex ]]; then
  echo "Invalid PR title: $title"
  echo "Expected: <type>(optional-scope): <description>"
  echo "Allowed PR title types: feat|fix|docs|refactor|perf|test|chore"
  exit 1
fi

echo "PR title check passed."
