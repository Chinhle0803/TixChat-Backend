#!/usr/bin/env bash

set -euo pipefail

REPO="${GITHUB_REPO:-Chinhle0803/TixChat-Backend}"
ENV_FILE="${1:-.env}"

VARIABLE_KEYS=(
  AWS_REGION
  DYNAMODB_USERS_TABLE
  DYNAMODB_CONVERSATIONS_TABLE
  DYNAMODB_MESSAGES_TABLE
  DYNAMODB_PARTICIPANTS_TABLE
  DYNAMODB_CALL_SESSIONS_TABLE
  DYNAMODB_NOTIFICATION_TOKENS_TABLE
  DYNAMODB_CALL_CONVERSATION_STATUS_INDEX
  JWT_EXPIRE
  JWT_REFRESH_EXPIRE
  AWS_SES_REGION
  AWS_S3_REGION
  S3_BUCKET_NAME
  S3_AVATAR_FOLDER
  S3_MESSAGE_FOLDER
  AWS_CHIME_REGION
  CHIME_MEETING_REGION
  CALL_RING_TIMEOUT_SECONDS
  REDIS_ENABLED
  NODE_ENV
  PORT
)

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is not installed." >&2
  echo "Install it first: https://cli.github.com/" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated." >&2
  echo "Run: gh auth login" >&2
  exit 1
fi

is_variable_key() {
  local key="$1"
  local item
  for item in "${VARIABLE_KEYS[@]}"; do
    if [[ "$item" == "$key" ]]; then
      return 0
    fi
  done
  return 1
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

strip_wrapping_quotes() {
  local value="$1"
  if [[ "$value" =~ ^\".*\"$ ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" =~ ^\'.*\'$ ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

echo "Using repo: $REPO"
echo "Reading env file: $ENV_FILE"

secret_count=0
variable_count=0

while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
  line="$(trim "$raw_line")"

  if [[ -z "$line" || "$line" == \#* ]]; then
    continue
  fi

  if [[ "$line" == export\ * ]]; then
    line="${line#export }"
  fi

  if [[ "$line" != *=* ]]; then
    continue
  fi

  key="$(trim "${line%%=*}")"
  value="$(trim "${line#*=}")"
  value="$(strip_wrapping_quotes "$value")"

  if [[ -z "$key" || -z "$value" ]]; then
    continue
  fi

  if is_variable_key "$key"; then
    gh variable set "$key" --repo "$REPO" --body "$value"
    echo "variable: $key"
    variable_count=$((variable_count + 1))
  else
    gh secret set "$key" --repo "$REPO" --body "$value"
    echo "secret: $key"
    secret_count=$((secret_count + 1))
  fi
done < "$ENV_FILE"

echo
echo "Done. Uploaded $secret_count secrets and $variable_count variables to $REPO."
