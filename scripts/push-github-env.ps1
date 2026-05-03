param(
    [string]$EnvFile = ".env",
    [string]$Repo = "Chinhle0803/TixChat-Backend"
)

$ErrorActionPreference = "Stop"

$variableKeys = @(
    "AWS_REGION",
    "DYNAMODB_USERS_TABLE",
    "DYNAMODB_CONVERSATIONS_TABLE",
    "DYNAMODB_MESSAGES_TABLE",
    "DYNAMODB_PARTICIPANTS_TABLE",
    "DYNAMODB_CALL_SESSIONS_TABLE",
    "DYNAMODB_NOTIFICATION_TOKENS_TABLE",
    "DYNAMODB_CALL_CONVERSATION_STATUS_INDEX",
    "JWT_EXPIRE",
    "JWT_REFRESH_EXPIRE",
    "AWS_SES_REGION",
    "AWS_S3_REGION",
    "S3_BUCKET_NAME",
    "S3_AVATAR_FOLDER",
    "S3_MESSAGE_FOLDER",
    "AWS_CHIME_REGION",
    "CHIME_MEETING_REGION",
    "CALL_RING_TIMEOUT_SECONDS",
    "REDIS_ENABLED",
    "NODE_ENV",
    "PORT"
)

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI (gh) chưa được cài. Cài tại https://cli.github.com/"
}

if (-not (Test-Path $EnvFile)) {
    throw "Không tìm thấy file env: $EnvFile"
}

gh auth status | Out-Null

$secretCount = 0
$variableCount = 0

Write-Host "Using repo: $Repo"
Write-Host "Reading env file: $EnvFile"

$lines = Get-Content -Path $EnvFile
foreach ($rawLine in $lines) {
    $line = $rawLine.Trim()

    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) {
        continue
    }

    if ($line.StartsWith("export ")) {
        $line = $line.Substring(7).Trim()
    }

    $pair = $line -split "=", 2
    if ($pair.Count -ne 2) {
        continue
    }

    $key = $pair[0].Trim()
    $value = $pair[1].Trim()

    if ([string]::IsNullOrWhiteSpace($key) -or [string]::IsNullOrWhiteSpace($value)) {
        continue
    }

    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }

    if ($variableKeys -contains $key) {
        gh variable set $key --repo $Repo --body $value | Out-Null
        Write-Host "variable: $key"
        $variableCount++
    }
    else {
        gh secret set $key --repo $Repo --body $value | Out-Null
        Write-Host "secret: $key"
        $secretCount++
    }
}

Write-Host ""
Write-Host "Done. Uploaded $secretCount secrets and $variableCount variables to $Repo."
