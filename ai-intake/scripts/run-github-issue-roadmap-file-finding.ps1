[CmdletBinding(DefaultParameterSetName = "Candidate")]
param(
  [Parameter(Mandatory = $true, ParameterSetName = "Candidate")]
  [ValidateNotNullOrEmpty()]
  [string] $Candidate,
  [Parameter(Mandatory = $true, ParameterSetName = "Delivery")]
  [ValidateNotNullOrEmpty()]
  [string] $Delivery,
  [Parameter(Mandatory = $true, ParameterSetName = "Inbox")]
  [ValidateNotNullOrEmpty()]
  [string] $Inbox,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[-A-Za-z0-9_.]+/[-A-Za-z0-9_.]+$')]
  [string] $Repository,
  [string] $CredentialPath = "",
  [ValidateRange(0, 2147483647)]
  [int] $WaitMinutes = 45,
  [switch] $Execute,
  [switch] $FreshCensus
)

# Operator filing, deliberately separate from the collector's confinement wrapper.
# Like intake-apply: DPAPI -> one child's ProcessStartInfo environment, never the
# parent's environment. This is an audit boundary, not owner-principal separation.
# BSTR is zeroed. Immutable .NET strings and the child's environment copy are freed,
# not zeroed; child exit is the real scrub. Grandchildren inherit that environment.
# Dry-run never opens the credential file. -Inbox reads non-hidden *.json records
# in culture-aware filename order, not merely the scan's subset of retained refs.
# Only boolean deliverable:true is attempted, with a fresh release per record.
# Journal and create-budget enforcement live in the child CLI, not this wrapper.
# Drain exit: 0 = all attempted records filed/replay/dry-run (including empty inbox);
# 1 = hold, invalid record, or refusal; 2 = pending ceiling (legacy child 3 also stops);
# 4 = infrastructure failure; 5 = busy. Counts are per candidate, not per child.

$ErrorActionPreference = "Stop"
if (-not [string]::IsNullOrWhiteSpace($env:ROADMAP_SHADOW_PUBLISH_TOKEN)) {
  throw "ROADMAP_SHADOW_PUBLISH_TOKEN is already set in this environment; refusing to run so the ambient credential is not silently reused."
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$tsxCli = Join-Path $repoRoot "node_modules\tsx\dist\cli.mjs"
$findingScript = Join-Path $repoRoot "scripts\github-issue-roadmap-file-finding.ts"

# ProcessStartInfo.Arguments uses Windows command-line quoting (.NET Framework /
# Windows PowerShell 5.1 has no ArgumentList). Quote every argument, including paths.
function ConvertTo-ProcessArgument {
  param([string] $Argument)
  return '"' + ($Argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Read-RedactedChildOutput {
  param([System.Diagnostics.Process] $Process, [string] $Token)
  $lines = [System.Collections.Generic.List[string]]::new()
  $stdout = $Process.StandardOutput.ReadLineAsync()
  $stderr = $Process.StandardError.ReadLineAsync()
  # Drain both pipes concurrently so a full stderr pipe cannot block stdout.
  while ($null -ne $stdout -or $null -ne $stderr) {
    foreach ($stream in @("stdout", "stderr")) {
      $pending = if ($stream -eq "stdout") { $stdout } else { $stderr }
      if ($null -eq $pending -or -not $pending.IsCompleted) { continue }
      $line = $pending.GetAwaiter().GetResult()
      if ($null -ne $line) {
        if (-not [string]::IsNullOrEmpty($Token)) { $line = $line.Replace($Token, "[REDACTED]") }
        $lines.Add($line)
      }
      if ($stream -eq "stdout") {
        $stdout = if ($null -eq $line) { $null } else { $Process.StandardOutput.ReadLineAsync() }
      } else {
        $stderr = if ($null -eq $line) { $null } else { $Process.StandardError.ReadLineAsync() }
      }
      $line = $null
      $pending = $null
    }
    if ($null -ne $stdout -or $null -ne $stderr) { Start-Sleep -Milliseconds 10 }
  }
  return ,$lines.ToArray()
}

function Test-IssueNumber {
  param($Number)
  return (($Number -is [int] -or $Number -is [long] -or $Number -is [double]) -and
    $Number -ge 1 -and $Number -le 9007199254740991 -and [math]::Truncate($Number) -eq $Number)
}

function Get-FindingExitCode {
  param($Result)
  $dispositions = @($Result.candidates | ForEach-Object { $_.disposition })
  if ($Result.status -ceq "busy") { return 5 }
  if ($Result.status -ceq "infrastructure" -or $dispositions -ccontains "interrupted") { return 4 }
  if ($dispositions -ccontains "hold" -or $dispositions -ccontains "refused") { return 1 }
  if ($dispositions -ccontains "pending") { return 2 }
  return 0
}

function Get-FindingResult {
  param([string] $Path, [string] $Token, [int] $ExitCode)
  $json = Get-Content -Raw -LiteralPath $Path -ErrorAction Stop
  if (-not [string]::IsNullOrEmpty($Token)) { $json = $json.Replace($Token, "[REDACTED]") }
  if (-not $json.TrimStart().StartsWith("{")) { throw "result must be a JSON object." }
  $result = $json | ConvertFrom-Json -ErrorAction Stop
  if ($result -isnot [pscustomobject] -or $result.schemaVersion -isnot [int] -or $result.schemaVersion -ne 1 -or
      $result.status -isnot [string] -or
      @("completed", "dry-run", "no-op", "busy", "infrastructure") -cnotcontains $result.status -or
      $result.runRoot -isnot [string] -or [string]::IsNullOrWhiteSpace($result.runRoot)) {
    throw "result schemaVersion/status/runRoot has an invalid type or value."
  }
  if ($result.requestedAssessor -isnot [pscustomobject]) { throw "requestedAssessor must be an object." }
  foreach ($field in @("provider", "model", "prompt", "release")) {
    if ($result.requestedAssessor.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($result.requestedAssessor.$field)) {
      throw "requestedAssessor.$field must be a nonempty string."
    }
  }
  if ($result.candidates -isnot [array]) { throw "candidates must be an array." }
  foreach ($candidate in $result.candidates) {
    if ($candidate -isnot [pscustomobject] -or $candidate.sourceFingerprint -isnot [string] -or
        $candidate.sourceFingerprint -cnotmatch '^[a-f0-9]{64}$' -or
        $candidate.stableOutcomeId -isnot [string] -or [string]::IsNullOrWhiteSpace($candidate.stableOutcomeId) -or
        $candidate.reason -isnot [string] -or [string]::IsNullOrWhiteSpace($candidate.reason) -or
        @("filed", "replay", "appended", "closed", "hold", "pending", "refused", "interrupted", "dry-run", "dispositioned") -cnotcontains $candidate.disposition) {
      throw "candidate identity/disposition/reason has an invalid type or value."
    }
    if ($candidate.disposition -ceq "dry-run") {
      if ($candidate.PSObject.Properties.Name -notcontains "projectedAction" -or
          ($null -ne $candidate.projectedAction -and @("create_issue", "append_evidence", "append_evidence_overlap", "close_issue", "close_issue_existence") -cnotcontains $candidate.projectedAction)) {
        throw "dry-run candidate requires a projectedAction (create_issue, append_evidence, append_evidence_overlap, close_issue, close_issue_existence, or null)."
      }
    }
    if ($candidate.PSObject.Properties.Name -contains "issueNumber") {
      if (-not (Test-IssueNumber $candidate.issueNumber)) { throw "candidate issueNumber must be a positive safe integer." }
    } elseif ($candidate.disposition -cin @("filed", "replay", "appended", "closed")) {
      throw "filed/replay/appended/closed candidate requires issueNumber."
    }
    if ($candidate.disposition -ceq "refused" -or $candidate.PSObject.Properties.Name -contains "fixingCommand") {
      if ($candidate.fixingCommand -isnot [string] -or [string]::IsNullOrWhiteSpace($candidate.fixingCommand)) {
        throw "refused candidate requires a nonempty fixingCommand."
      }
    }
    if ($candidate.disposition -ceq "hold" -or $candidate.PSObject.Properties.Name -contains "competingIssues") {
      if ($candidate.competingIssues -isnot [array]) { throw "hold competingIssues must be an array." }
      foreach ($number in $candidate.competingIssues) {
        if (-not (Test-IssueNumber $number)) { throw "competingIssues must contain positive safe integers." }
      }
    }
    if ($candidate.PSObject.Properties.Name -contains "suggestions") {
      if ($candidate.suggestions -isnot [array]) { throw "suggestions must be an array." }
      foreach ($suggestion in $candidate.suggestions) {
        if ($suggestion -isnot [pscustomobject] -or @("append", "close") -cnotcontains $suggestion.kind -or
            -not (Test-IssueNumber $suggestion.targetIssueNumber)) {
          throw "each suggestion requires an append/close kind and targetIssueNumber."
        }
      }
    }
    if ($candidate.PSObject.Properties.Name -contains "suggestion") {
      if ($candidate.suggestion -isnot [pscustomobject] -or @("append", "close") -cnotcontains $candidate.suggestion.kind -or
          -not (Test-IssueNumber $candidate.suggestion.targetIssueNumber)) {
        throw "suggestion requires an append/close kind and targetIssueNumber."
      }
    }
  }
  if ($result.PSObject.Properties.Name -contains "apply" -and $result.apply -isnot [pscustomobject]) {
    throw "result apply must be an object."
  }
  if ((Get-FindingExitCode $result) -ne $ExitCode) { throw "child exit code disagrees with candidate dispositions." }
  # Retain only validated reporting fields, not the unused nested apply payload.
  return [pscustomobject]@{ status = $result.status; runRoot = $result.runRoot; candidates = $result.candidates; metrics = $result.metrics }
}

function Invoke-FindingChild {
  param([string] $Mode, [string] $Path)
  # Check on every invocation, before any credential file access.
  if (-not [string]::IsNullOrWhiteSpace($env:ROADMAP_SHADOW_PUBLISH_TOKEN)) {
    throw "ROADMAP_SHADOW_PUBLISH_TOKEN is already set; refusing ambient credential."
  }
  $plainToken = $null
  $process = $null
  $startInfo = $null
  $resultDirectory = $null
  $started = $false
  try {
    # Re-resolve before each release: a missing executable is infrastructure failure.
    $nodeExecutable = (Get-Command node -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) { throw "node executable is unavailable: $nodeExecutable" }
    if (-not (Test-Path -LiteralPath $tsxCli -PathType Leaf)) { throw "tsx is unavailable at $tsxCli." }
    $resultDirectory = Join-Path ([IO.Path]::GetTempPath()) ("roadmap-finding-" + [guid]::NewGuid().ToString("N"))
    [void][IO.Directory]::CreateDirectory($resultDirectory)
    $resultPath = Join-Path $resultDirectory "result.json"
    # Preserve caller-relative sidecar paths while the child runs at the repository root.
    $childPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    $arguments = @($tsxCli, $findingScript, "--${Mode}=$childPath", "--repository=$Repository", "--result=$resultPath", "--wait-minutes=$WaitMinutes")
    if ($FreshCensus) { $arguments += "--fresh-census" }
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $nodeExecutable
    $startInfo.WorkingDirectory = $repoRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    if ($Execute) {
      $releasePath = $CredentialPath
      if ([string]::IsNullOrWhiteSpace($releasePath)) {
        $releasePath = Join-Path $env:USERPROFILE ".codex\roadmap-shadow-activation\roadmap-shadow-publish-token.dpapi"
      }
      if (-not [System.IO.Path]::IsPathRooted($releasePath) -or -not (Test-Path -LiteralPath $releasePath -PathType Leaf)) {
        throw "credential_unreadable: The intake publish credential is missing or not an absolute regular file: $releasePath. Fix: rerun this wrapper with -Execute -CredentialPath <absolute-readable-DPAPI-file>."
      }
      $securityModulePath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
      Import-Module -Name $securityModulePath -ErrorAction Stop
      try {
        $secureToken = ConvertTo-SecureString ((Get-Content -Raw -LiteralPath $releasePath).Trim())
        try {
          $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
          try { $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer) }
          finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer) }
        } finally { $secureToken.Dispose() }
        if ([string]::IsNullOrWhiteSpace($plainToken)) { throw "The DPAPI-protected publish credential decrypted empty." }
      } catch {
        throw "credential_unreadable: $($_.Exception.Message) Fix: rerun this wrapper with -Execute -CredentialPath <absolute-readable-DPAPI-file> under the Windows account that protected it."
      }
      $arguments += "--execute"
      $startInfo.EnvironmentVariables["ROADMAP_SHADOW_PUBLISH_TOKEN"] = $plainToken
    }
    $startInfo.Arguments = ($arguments | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join " "
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $started = $process.Start()
    if (-not $started) { throw "file-finding child could not start." }
    $output = Read-RedactedChildOutput -Process $process -Token $plainToken
    $process.WaitForExit()
    $childExitCode = $process.ExitCode
    $result = $null
    $resultError = $null
    try { $result = Get-FindingResult -Path $resultPath -Token $plainToken -ExitCode $childExitCode }
    catch {
      $resultError = $_.Exception.Message
      if (-not [string]::IsNullOrEmpty($plainToken)) { $resultError = $resultError.Replace($plainToken, "[REDACTED]") }
    }
    return [pscustomobject]@{ Lines = $output; ExitCode = $childExitCode; Result = $result; ResultError = $resultError }
  } catch {
    $message = $_.Exception.Message
    if (-not [string]::IsNullOrEmpty($plainToken)) { $message = $message.Replace($plainToken, "[REDACTED]") }
    throw $message
  } finally {
    # Drop plaintext references before fallible cleanup. Parent env was never changed.
    $plainToken = $null
    if ($null -ne $startInfo) { $startInfo.EnvironmentVariables.Remove("ROADMAP_SHADOW_PUBLISH_TOKEN") }
    try {
      if ($null -ne $process) {
        try { if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() } }
        finally { $process.Dispose() }
      }
    } finally {
      if ($null -ne $resultDirectory) { Remove-Item -LiteralPath $resultDirectory -Recurse -Force -ErrorAction Stop }
    }
  }
}

function Get-FindingReport {
  param($Child)
  $result = $Child.Result
  if ($null -eq $result) {
    $line = [pscustomobject]@{ Status = "refused"; Detail = "child_exit=$($Child.ExitCode): missing, invalid or inconsistent result ($($Child.ResultError)) $(($Child.Lines -join ' ').Trim())" }
    return [pscustomobject]@{ Lines = @($line); ExitCode = 1; Pending = $false }
  }
  $lines = @(
    foreach ($candidate in $result.candidates) {
      $detail = $candidate.reason
      if ($candidate.issueNumber) { $detail = "issue #$($candidate.issueNumber) $detail" }
      $detail += " [outcome: $($candidate.stableOutcomeId); fingerprint: $($candidate.sourceFingerprint)]"
      if ($candidate.disposition -ceq "hold") { $detail += " competing issues: " + (($candidate.competingIssues | ForEach-Object { "#$_" }) -join ', ') }
      if ($candidate.fixingCommand) { $detail += " fix: $($candidate.fixingCommand)" }
      $suggestions = if ($candidate.PSObject.Properties.Name -contains "suggestions") { $candidate.suggestions } else { $candidate.suggestion }
      foreach ($kind in @("append", "close")) {
        $targets = @($suggestions | Where-Object { $_.kind -ceq $kind } | ForEach-Object { "#$($_.targetIssueNumber)" })
        if ($targets.Count -gt 0) { $detail += " suggested $kind " + ($targets -join ', ') }
      }
      if ($candidate.disposition -ceq "dry-run") {
        $projection = if ($null -eq $candidate.projectedAction) { "none" } else { $candidate.projectedAction }
        $detail += " projected action: $projection"
      }
      [pscustomobject]@{ Status = $candidate.disposition; Detail = "$detail [artifacts: $($result.runRoot)]" }
    }
    if ($result.status -cin @("no-op", "busy", "infrastructure") -or ($result.status -ceq "dry-run" -and $result.candidates.Count -eq 0)) {
      [pscustomobject]@{ Status = $result.status; Detail = "[artifacts: $($result.runRoot)]"; CountCandidate = $false }
    }
  )
  return [pscustomobject]@{ Lines = $lines; ExitCode = $Child.ExitCode; Pending = @($result.candidates | Where-Object { $_.disposition -ceq "pending" }).Count -gt 0; Metrics = $result.metrics }
}

function Format-FindingMetrics {
  param($Metrics)
  if ($null -eq $Metrics) { return "" }
  $reads = @($Metrics.githubReads.PSObject.Properties | ForEach-Object { "$($_.Name):$($_.Value)" })
  $total = ($Metrics.githubReads.PSObject.Properties | Measure-Object -Property Value -Sum).Sum
  $durations = @($Metrics.durationsMs.PSObject.Properties | ForEach-Object { "$($_.Name):$($_.Value)" })
  return " census=$($Metrics.censusMode) github_reads=$total reads_by_stage=$($reads -join ',') durations_ms=$($durations -join ',')"
}

function New-FindingCounts {
  return [ordered]@{ filed = 0; replay = 0; 'dry-run' = 0; hold = 0; refused = 0; appended = 0; closed = 0; pending = 0; interrupted = 0 }
}

function Write-FindingLines {
  param($Lines, [string] $Path, $Counts)
  foreach ($line in $Lines) {
    if ($line.CountCandidate -ne $false -and $Counts.Contains($line.Status)) { $Counts[$line.Status]++ }
    Write-Output ("{0} | {1} | {2}" -f $line.Status.ToUpperInvariant(), $Path, (($line.Detail -replace '[\r\n]+', ' ').Trim()))
  }
}

function Format-FindingCounts {
  param($Counts)
  return (($Counts.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')
}

function Merge-FindingExitCode {
  param([int] $Previous, [int] $Current)
  foreach ($code in @(5, 4, 1, 2)) { if ($Previous -eq $code -or $Current -eq $code) { return $code } }
  return 0
}

if ($PSCmdlet.ParameterSetName -ne "Inbox") {
  $mode = if ($PSCmdlet.ParameterSetName -eq "Candidate") { "candidate" } else { "delivery" }
  $path = if ($mode -eq "candidate") { $Candidate } else { $Delivery }
  $child = $null
  try { $child = Invoke-FindingChild -Mode $mode -Path $path }
  catch { Write-Output "INFRASTRUCTURE | $($_.Exception.Message)"; exit 4 }
  try {
    $child.Lines | Write-Output
    $report = Get-FindingReport -Child $child
    $counts = New-FindingCounts
    Write-FindingLines -Lines $report.Lines -Path $path -Counts $counts
    $exitCode = if ($child.ExitCode -eq 3) { 3 } else { $report.ExitCode }
    Write-Output ("RESULT | {0} exit={1}{2}" -f (Format-FindingCounts $counts), $exitCode, (Format-FindingMetrics $report.Metrics))
  } finally { $child.Lines = @(); $child = $null }
  exit $exitCode
}

if (-not (Test-Path -LiteralPath $Inbox -PathType Container)) {
  Write-Output "INFRASTRUCTURE | Finding inbox is missing: $Inbox"
  exit 4
}
$records = @(Get-ChildItem -LiteralPath $Inbox -Filter "*.json" -File | Sort-Object Name)
$counts = New-FindingCounts
$attempted = 0
$visited = 0
$drainExitCode = 0
foreach ($record in $records) {
  $visited++
  $status = "refused"
  $detail = ""
  $budgetExhausted = $false
  $recordExitCode = 1
  $report = $null
  $infrastructureError = $null
  $child = $null
  try {
    $deliveryRecord = Get-Content -Raw -LiteralPath $record.FullName | ConvertFrom-Json -ErrorAction Stop
    if ($deliveryRecord.verification.deliverable -isnot [bool]) { throw "delivery_record_invalid: verification.deliverable must be boolean." }
    if (-not $deliveryRecord.verification.deliverable) {
      $status = "hold"
      $detail = "undeliverable (not attempted): $($deliveryRecord.verification.reason)"
    } else {
      try { $child = Invoke-FindingChild -Mode "delivery" -Path $record.FullName }
      catch { $infrastructureError = $_.Exception.Message }
      if ($null -eq $infrastructureError) {
        $attempted++
        $budgetExhausted = $child.ExitCode -eq 3
        $report = Get-FindingReport -Child $child
        $budgetExhausted = $budgetExhausted -or $report.Pending
        $recordExitCode = $report.ExitCode
      }
    }
  } catch { $detail = $_.Exception.Message }
  try {
    if ($null -ne $infrastructureError) {
      Write-Output ("INFRASTRUCTURE | {0} | {1}" -f $record.Name, ($infrastructureError -replace '[\r\n]+', ' '))
      $drainExitCode = 4
      break
    }
    if ($null -eq $report) { $report = [pscustomobject]@{ Lines = @([pscustomobject]@{ Status = $status; Detail = $detail }) } }
    Write-FindingLines -Lines $report.Lines -Path $record.Name -Counts $counts
    # Legacy exit 3 remains a stop signal even if its old result fails validation.
    if ($null -ne $child -and $child.ExitCode -eq 3) { $recordExitCode = 2 }
    $drainExitCode = Merge-FindingExitCode $drainExitCode $recordExitCode
    if ($recordExitCode -in @(4, 5)) { break }
    if ($budgetExhausted) {
      Write-Output "STOP | repository_create_budget_exhausted | remaining records not attempted"
      break
    }
  } finally {
    if ($null -ne $child) { $child.Lines = @() }
    $child = $null
    $report = $null
    $detail = $null
  }
}
Write-Output ("DRAIN | attempted={0} {1} remaining={2} exit={3}" -f $attempted, (Format-FindingCounts $counts), ($records.Count - $visited), $drainExitCode)
exit $drainExitCode
