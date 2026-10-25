param(
  [Parameter(Mandatory = $true)]
  [string] $Plan,
  [string] $Ledger = "",
  [string] $CredentialPath = "",
  [string] $RunEvidence = "",
  [string] $OriginMainSha = "",
  [string[]] $Candidate = @(),
  [string[]] $Existence = @(),
  [switch] $Execute,
  # Supervised operator runs only: exceed the repository create ceiling. The CLI
  # records the flag, operator, run ID and prior count on every intent it produces,
  # and refuses it for immediate filing or any non-execute mode.
  [switch] $AllowCreateBudgetOverrun
)

# Operator intake apply, with the write credential scoped to one child invocation.
#
# `scripts/github-issue-roadmap-intake-apply.ts --execute` requires
# ROADMAP_SHADOW_PUBLISH_TOKEN and deliberately refuses stored `gh` auth, so the token has to
# arrive explicitly. This wrapper is how it arrives: it decrypts the DPAPI-protected credential,
# hands it to exactly one child's ProcessStartInfo environment, never the parent's. The token never has to be
# typed, pasted, or left in an operator shell's environment, and a scheduled invocation can take
# the same path an interactive one does.
#
# This is deliberately NOT the collector's confinement wrapper. That one proves credential
# ABSENCE, because the evaluator's verdict only means something if it could not have read
# GitHub. This one does the opposite job: it grants exactly one write authority, briefly. Do not
# merge the two -- the collector's isolated-home and authority-stripping behaviour would break
# the write the apply path exists to perform.
# Dry-run is the default and never opens the credential file. Execute requires the
# current origin/main SHA and run evidence. Candidate/existence inputs are optional
# execute-only bindings forwarded to the child's revalidation.
# BSTR is zeroed. Immutable .NET strings and the child's environment copy are freed,
# not zeroed; child exit is the real scrub. Grandchildren inherit that environment.

$ErrorActionPreference = "Stop"

function Test-AbsoluteWindowsPath {
  param([string] $Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  try { return [System.IO.Path]::IsPathRooted($Path) } catch { return $false }
}

$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path -LiteralPath $Plan -PathType Leaf)) {
  throw "The approval plan is missing or not a regular file: $Plan"
}

# Refuse to start when a write credential is already sitting in the caller's environment. The
# whole point of this wrapper is that the operator shell never holds one; finding it pre-set
# means the boundary has already been crossed somewhere upstream, and inheriting it would hide
# that rather than surface it.
if (-not [string]::IsNullOrWhiteSpace($env:ROADMAP_SHADOW_PUBLISH_TOKEN)) {
  throw "ROADMAP_SHADOW_PUBLISH_TOKEN is already set in this environment; refusing to run so the ambient credential is not silently reused."
}

if ($Execute) {
  if ($OriginMainSha -cnotmatch '^[0-9a-f]{40}$' -or [string]::IsNullOrWhiteSpace($RunEvidence)) {
    throw "Execute requires -OriginMainSha <trusted-current-sha> and -RunEvidence <path>."
  }
} elseif ($OriginMainSha -ne "" -or $Candidate.Count -gt 0 -or $Existence.Count -gt 0 -or $AllowCreateBudgetOverrun) {
  throw "-OriginMainSha, -Candidate, -Existence and -AllowCreateBudgetOverrun are supported only with -Execute."
}

$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$tsxCli = Join-Path $repoRoot "node_modules\tsx\dist\cli.mjs"
if (-not (Test-Path -LiteralPath $tsxCli -PathType Leaf)) {
  throw "tsx is unavailable at $tsxCli. Install repository dependencies before running apply."
}

$applyScript = Join-Path $repoRoot "scripts\github-issue-roadmap-intake-apply.ts"
$arguments = @($tsxCli, $applyScript, "--plan=$Plan")
if ($Execute) {
  $arguments += @("--execute", "--origin-main-sha=$OriginMainSha")
  foreach ($path in $Candidate) { $arguments += "--candidate=$path" }
  foreach ($path in $Existence) { $arguments += "--existence=$path" }
  if ($AllowCreateBudgetOverrun) { $arguments += "--allow-create-budget-overrun" }
}
if (-not [string]::IsNullOrWhiteSpace($RunEvidence)) {
  $arguments += "--run-evidence=$RunEvidence"
}
if (-not [string]::IsNullOrWhiteSpace($Ledger)) {
  $arguments += "--ledger=$Ledger"
}


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

$plainToken = $null
$process = $null
$startInfo = $null
$started = $false
$output = @()
try {
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $nodeExecutable
  $startInfo.WorkingDirectory = (Get-Location).ProviderPath
  $startInfo.Arguments = ($arguments | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join " "
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  if ($Execute) {
    if ([string]::IsNullOrWhiteSpace($CredentialPath)) {
      $CredentialPath = Join-Path $env:USERPROFILE ".codex\roadmap-shadow-activation\roadmap-shadow-publish-token.dpapi"
    }
    if (-not (Test-AbsoluteWindowsPath $CredentialPath) -or -not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) {
      throw "The intake publish credential is missing or not an absolute regular file: $CredentialPath"
    }
    $securityModulePath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
    Import-Module -Name $securityModulePath -ErrorAction Stop
    $secureToken = ConvertTo-SecureString ((Get-Content -Raw -LiteralPath $CredentialPath).Trim())
    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    try {
      $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
      $secureToken.Dispose()
    }
    if ([string]::IsNullOrWhiteSpace($plainToken)) {
      throw "The DPAPI-protected publish credential decrypted empty."
    }
    $startInfo.EnvironmentVariables["ROADMAP_SHADOW_PUBLISH_TOKEN"] = $plainToken
  }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $started = $process.Start()
  if (-not $started) { throw "intake-apply child could not start." }
  $output = Read-RedactedChildOutput -Process $process -Token $plainToken
  $process.WaitForExit()
  $applyExitCode = $process.ExitCode
  $output | Write-Output
} catch {
  $message = $_.Exception.Message
  if (-not [string]::IsNullOrEmpty($plainToken)) { $message = $message.Replace($plainToken, "[REDACTED]") }
  throw $message
} finally {
  # Drop references before fallible disposal; the parent environment never held it.
  $plainToken = $null
  $output = @()
  if ($null -ne $startInfo) { $startInfo.EnvironmentVariables.Remove("ROADMAP_SHADOW_PUBLISH_TOKEN") }
  if ($null -ne $process) {
    try { if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() } }
    finally { $process.Dispose() }
  }
}

if ($applyExitCode -ne 0) {
  throw "Operator intake apply exited with code $applyExitCode."
}
