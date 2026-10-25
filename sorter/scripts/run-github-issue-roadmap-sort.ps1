[CmdletBinding()]
param(
  [ValidateSet('init', 'preview', 'shadow', 'approve', 'rehearse', 'run', 'status', 'pause', 'resume', 'release', 'pin', 'notify', 'policy-update', 'policy-upgrade', 'seat-preflight', 'lifecycle-receipts')]
  [string] $Command = 'status',
  [switch] $Scheduled,
  [switch] $RunAssembly,
  [string] $GlmSlot = 'primary',
  [int] $Issue = 0,
  [ValidateSet('', 'Priority', 'Horizon')] [string] $Field = '',
  [string] $Snapshot = '',
  [ValidateSet(1, 2)] [int] $PreflightConcurrency = 1,
  [ValidateSet('preflight', 'fence', 'readback')] [string[]] $InjectTransient = @(),
  [string] $FilingFieldReceipts = '',
  [string] $Out = '',
  [ValidateSet('v1', 'v2')] [string] $ReceiptsSchema = 'v1'
)
$ErrorActionPreference = 'Stop'

function ConvertTo-SortArgument {
  param([string] $Argument)
  return '"' + ($Argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function New-SortEnvironment {
  # OAuth/DPAPI remain available to the separately confined model launchers.
  # No GitHub authority, provider redirect, Node injection or Git override is inherited.
  $result = @{}
  foreach ($name in @('SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
    'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'USERNAME', 'USERDOMAIN', 'ProgramFiles', 'ProgramFiles(x86)')) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($null -ne $value) { $result[$name] = $value }
  }
  $result['ProgramFiles'] = [Environment]::GetFolderPath('ProgramFiles')
  $result['USERPROFILE'] = [Environment]::GetFolderPath('UserProfile')
  $result['SystemRoot'] = [Environment]::GetFolderPath('Windows')
  return $result
}

function Invoke-SortChild {
  param([string] $Executable, [string[]] $Arguments, [hashtable] $Environment,
    [string] $WorkingDirectory, [string] $SensitiveValue = '', [int] $TimeoutSeconds = 10980)
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $Executable
  $info.Arguments = ($Arguments | ForEach-Object { ConvertTo-SortArgument $_ }) -join ' '
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $info.EnvironmentVariables.Clear()
  foreach ($name in $Environment.Keys) { $info.EnvironmentVariables[$name] = $Environment[$name] }
  $child = [Diagnostics.Process]::new(); $child.StartInfo = $info
  $started = $false
  try {
    $started = $child.Start()
    if (-not $started) { throw 'Roadmap child could not start.' }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $buffers = @{ Out = [char[]]::new(4096); Err = [char[]]::new(4096) }
    $readers = @{ Out = $child.StandardOutput; Err = $child.StandardError }
    $pending = @{}; $text = @{ Out = [Text.StringBuilder]::new(); Err = [Text.StringBuilder]::new() }
    foreach ($stream in @('Out', 'Err')) { $pending[$stream] = $readers[$stream].ReadAsync($buffers[$stream], 0, 4096) }
    while ($pending.Count -gt 0 -or -not $child.HasExited) {
      if ($clock.Elapsed.TotalSeconds -gt $TimeoutSeconds -or $text.Out.Length + $text.Err.Length -gt 2097152) {
        throw 'Roadmap child exceeded its deadline or output limit.'
      }
      foreach ($stream in @('Out', 'Err')) {
        if (-not $pending.ContainsKey($stream) -or -not $pending[$stream].IsCompleted) { continue }
        $count = $pending[$stream].GetAwaiter().GetResult()
        if ($count -eq 0) { $pending.Remove($stream); continue }
        [void]$text[$stream].Append($buffers[$stream], 0, $count)
        $pending[$stream] = $readers[$stream].ReadAsync($buffers[$stream], 0, 4096)
      }
      Start-Sleep -Milliseconds 10
    }
    $child.WaitForExit()
    $stdout = $text.Out.ToString(); $stderr = $text.Err.ToString()
    # Redact in memory, before returning anything to logs or a caller.
    if ($SensitiveValue) { $stdout = $stdout.Replace($SensitiveValue, '[REDACTED]'); $stderr = $stderr.Replace($SensitiveValue, '[REDACTED]') }
    return @{ ExitCode = $child.ExitCode; Stdout = $stdout; Stderr = $stderr }
  } finally {
    $info.EnvironmentVariables.Clear()
    if ($started -and -not $child.HasExited) {
      & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /pid $child.Id /t /f *> $null
      $child.WaitForExit(5000) | Out-Null
    }
    $child.Dispose()
  }
}

function Get-SortExecutable {
  param([string] $RelativePath, [switch] $UserInstallation)
  $folder = if ($UserInstallation) { 'UserProfile' } else { 'ProgramFiles' }
  $path = Join-Path ([Environment]::GetFolderPath($folder)) $RelativePath
  $item = Get-Item -LiteralPath $path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    (Get-AuthenticodeSignature -LiteralPath $path).Status -ne 'Valid') { throw 'Required signed host executable is unavailable.' }
  return $path
}

# Windows PowerShell 5.1 can project ToastNotifier.Setting as null even though Show() succeeds,
# so only an explicitly non-Enabled setting refuses submission.
function Test-SortNotifierEnabled {
  param($Setting)
  if ($null -eq $Setting) { return $true }
  return ($Setting.ToString() -eq "Enabled")
}

function Submit-SortNotification {
  param([string] $ReportId, [string] $Summary)
  if ($ReportId -cnotmatch '^[0-9a-f]{64}$' -or $Summary.Length -gt 2000) { return $false }
  try {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell')
    $setting = $null
    try { $setting = $notifier.Setting } catch { return $false }
    if (-not (Test-SortNotifierEnabled $setting)) { return $false }
    $document = [Windows.Data.Xml.Dom.XmlDocument]::new()
    $escaped = [Security.SecurityElement]::Escape($Summary)
    $document.LoadXml("<toast><visual><binding template=`"ToastGeneric`"><text>Workflow tools roadmap</text><text>$escaped</text></binding></visual></toast>")
    $toast = [Windows.UI.Notifications.ToastNotification]::new($document)
    $toast.Tag = $ReportId.Substring(0, 16); $toast.Group = 'WorkflowToolsRoadmap'
    $notifier.Show($toast)
    # Windows accepted submission. This does not establish human receipt or activation proof.
    return $true
  } catch { return $false }
}

trap {
  $startupFailure = $_
  if ($Scheduled -and $Command -eq 'run') {
    # A health alert is not a persisted cycle report or a delivery receipt.
    try { [void](Submit-SortNotification -ReportId ('0' * 64) -Summary 'Roadmap sorting could not complete. Run roadmap:sort:secure status to inspect its state; the schedule remains unchanged.') } catch {}
  }
  throw $startupFailure
}

# ValidateSet binds case-insensitively; the CLI matches exact lowercase names.
if ($GlmSlot -cnotmatch '^[a-z0-9][a-z0-9-]{0,31}$' -or $GlmSlot -match '[\r\n]') { throw 'Invalid GLM credential slot.' }
$Command = $Command.ToLowerInvariant()
if ($RunAssembly -and $Command -ne 'preview') { throw '-RunAssembly requires preview.' }
if (($Snapshot -or $PSBoundParameters.ContainsKey('Snapshot')) -and $Command -notin @('approve', 'rehearse')) { throw '-Snapshot requires approve.' }
if ($Command -eq 'rehearse' -and $Snapshot -cnotmatch '\A[a-f0-9]{64}\z') { throw 'Rehearse requires -Snapshot with 64 lowercase hexadecimal characters.' }
if (($PSBoundParameters.ContainsKey('PreflightConcurrency') -or $PSBoundParameters.ContainsKey('InjectTransient')) -and $Command -ne 'rehearse') { throw 'Rehearsal options require rehearse.' }
# \A and \z: .NET '$' also matches before a trailing newline.
if ($Command -eq 'approve' -and $Snapshot -cnotmatch '\A[a-f0-9]{64}\z') { throw 'Approve requires -Snapshot with 64 lowercase hexadecimal characters.' }
if ($FilingFieldReceipts -or $PSBoundParameters.ContainsKey('FilingFieldReceipts')) {
  if ($Command -notin @('preview', 'shadow', 'run')) { throw '-FilingFieldReceipts requires preview, shadow or run.' }
  $receipts = Get-Item -LiteralPath $FilingFieldReceipts -Force
  if ($receipts -isnot [IO.FileInfo] -or ($receipts.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '-FilingFieldReceipts requires an existing regular file, not a reparse point.' }
  $FilingFieldReceipts = $receipts.FullName
}
if (($Out -or $PSBoundParameters.ContainsKey('Out')) -and $Command -ne 'lifecycle-receipts') { throw '-Out requires lifecycle-receipts.' }
if ($PSBoundParameters.ContainsKey('ReceiptsSchema') -and $Command -ne 'lifecycle-receipts') { throw '-ReceiptsSchema requires lifecycle-receipts.' }
if ($Command -eq 'lifecycle-receipts') {
  if ([string]::IsNullOrWhiteSpace($Out)) { throw 'Lifecycle receipts require -Out.' }
  $Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
  $parent = Get-Item -LiteralPath (Split-Path -Parent $Out) -Force
  if ($parent -isnot [IO.DirectoryInfo]) { throw '-Out requires an existing parent directory.' }
  if (Test-Path -LiteralPath $Out) { throw '-Out must name a file that does not exist yet.' }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$node = Get-SortExecutable 'nodejs\node.exe'
$tsx = Join-Path $repoRoot 'node_modules\tsx\dist\cli.mjs'
$script = Join-Path $repoRoot 'scripts\github-issue-roadmap-sort.ts'
if (-not (Test-Path -LiteralPath $tsx -PathType Leaf)) { throw 'Install the locked dependencies before using the sorter.' }
$environment = New-SortEnvironment
$arguments = @($tsx, $script, $Command)
if ($Command -eq 'approve') { $arguments += $Snapshot }
if ($Command -eq 'rehearse') {
  $arguments += "--snapshot=$Snapshot"
  $arguments += "--preflight-concurrency=$PreflightConcurrency"
  foreach ($phase in $InjectTransient) { $arguments += "--inject-transient=$phase" }
}
$arguments += "--glm-slot=$GlmSlot"
if ($RunAssembly) { $arguments += '--run-assembly' }
if ($FilingFieldReceipts) { $arguments += "--filing-field-receipts=$FilingFieldReceipts" }
if ($Out) { $arguments += "--out=$Out" }
if ($PSBoundParameters.ContainsKey('ReceiptsSchema')) { $arguments += "--schema=$($ReceiptsSchema.ToLowerInvariant())" }
if ($Scheduled) {
  if ($Command -ne 'run') { throw '-Scheduled requires run.' }
  if (-not $PSBoundParameters.ContainsKey('GlmSlot')) { throw '-Scheduled requires an explicitly passed -GlmSlot (use secondary for the sorter task).' }
  $arguments += '--scheduled'
}
if ($Issue -ne 0) { $arguments += "--issue=$Issue" }
if ($Field) { $arguments += "--field=$Field" }
$plainToken = $null
$runCompleted = $false
try {
  $shouldRun = $Command -ne 'notify'
  if ($Scheduled) {
    # The 900-second timeout is a stopgap for #2469.
    $check = Invoke-SortChild -Executable $node -Arguments @($tsx, $script, 'status') -Environment $environment -WorkingDirectory $repoRoot -TimeoutSeconds 900
    if ($check.ExitCode -ne 0) { throw 'Scheduled sorter status unavailable; explicit adoption or recovery required.' }
    $status = $check.Stdout | ConvertFrom-Json
    $shouldRun = $status.runDue -eq $true
  }
  if ($shouldRun -and $Command -in @('init', 'preview', 'shadow', 'approve', 'rehearse', 'run', 'release')) {
    $git = Get-SortExecutable 'Git\cmd\git.exe'
    [void](Get-SortExecutable 'GitHub CLI\gh.exe')
    [void](Get-SortExecutable '.local\bin\claude.exe' -UserInstallation)
    $gitEnvironment = New-SortEnvironment
    $gitEnvironment.GIT_CONFIG_NOSYSTEM = '1'; $gitEnvironment.GIT_CONFIG_SYSTEM = 'NUL'; $gitEnvironment.GIT_CONFIG_GLOBAL = 'NUL'
    $gitEnvironment.GIT_TERMINAL_PROMPT = '0'
    $gitPrefix = @('-C', $repoRoot, '-c', 'credential.helper=', '-c', 'core.hooksPath=NUL', '-c', 'core.fsmonitor=false', '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always')
    $origin = Invoke-SortChild -Executable $git -Arguments ($gitPrefix + @('remote', 'get-url', 'origin')) -Environment $gitEnvironment -WorkingDirectory $repoRoot -TimeoutSeconds 30
    if ($origin.ExitCode -ne 0 -or $origin.Stdout.Trim() -cne 'https://github.com/example-org/example-repo.git') { throw 'Sorter origin must match the configured repository.' }
    $config = Invoke-SortChild -Executable $git -Arguments ($gitPrefix + @('config', '--local', '--get-regexp', '^(url\.|http\.|include|credential\.|core\.(sshCommand|gitProxy))')) -Environment $gitEnvironment -WorkingDirectory $repoRoot -TimeoutSeconds 30
    if ($config.ExitCode -ne 1 -or $config.Stdout.Trim()) { throw 'Sorter checkout has unsupported local transport configuration.' }
    $clean = Invoke-SortChild -Executable $git -Arguments ($gitPrefix + @('status', '--porcelain=v1', '--untracked-files=all')) -Environment $gitEnvironment -WorkingDirectory $repoRoot -TimeoutSeconds 30
    if ($clean.ExitCode -ne 0 -or $clean.Stdout.Trim()) { throw 'Sorter requires a clean installed checkout.' }
    $ancestor = Invoke-SortChild -Executable $git -Arguments ($gitPrefix + @('merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main')) -Environment $gitEnvironment -WorkingDirectory $repoRoot -TimeoutSeconds 30
    if ($ancestor.ExitCode -ne 0) { throw 'Sorter installation must be a merged main revision before credential release.' }
    $credential = Join-Path $env:USERPROFILE '.codex\roadmap-shadow-activation\roadmap-shadow-publish-token.dpapi'
    Import-Module (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
    $secure = ConvertTo-SecureString ([IO.File]::ReadAllText($credential).Trim())
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
    if ([string]::IsNullOrWhiteSpace($plainToken)) { throw 'The protected sorter credential is empty.' }
    # Header value exists only in this child environment, never command arguments or a file.
    $gitEnvironment.ROADMAP_SORT_AUTH_HEADER = 'Authorization: Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("x-access-token:$plainToken"))
    try {
      $fetched = Invoke-SortChild -Executable $git -Arguments ($gitPrefix + @('--config-env=http.https://github.com/.extraHeader=ROADMAP_SORT_AUTH_HEADER', 'fetch', '--no-tags', 'https://github.com/example-org/example-repo.git', '+refs/heads/main:refs/remotes/origin/main')) -Environment $gitEnvironment -WorkingDirectory $repoRoot -SensitiveValue $plainToken -TimeoutSeconds 120
      if ($fetched.ExitCode -ne 0) { throw 'Sorter main refresh failed; no assessment started.' }
    } finally { $gitEnvironment.Clear() }
    $environment.ROADMAP_SORT_GITHUB_TOKEN = $plainToken
  }
  if ($shouldRun) {
    $result = Invoke-SortChild -Executable $node -Arguments $arguments -Environment $environment -WorkingDirectory $repoRoot -SensitiveValue $plainToken
    if ($result.Stdout) { Write-Output $result.Stdout.Trim() }
    if ($result.ExitCode -ne 0) { throw 'Sorter command failed; inspect its durable status and report.' }
    $runCompleted = $Command -eq 'run'
  }
} finally {
  $environment.Remove('ROADMAP_SORT_GITHUB_TOKEN'); $plainToken = $null
}

if ($Command -in @('run', 'notify')) {
  # Delivery retries never enter run, collect, assess or write paths.
  # The 900-second status/delivery timeout is a stopgap for #2469.
  # After a successful run or when no run is due, delivery failures warn and exit 0.
  try {
    $pending = Invoke-SortChild -Executable $node -Arguments @($tsx, $script, 'status') -Environment $environment -WorkingDirectory $repoRoot -TimeoutSeconds 900
    if ($pending.ExitCode -ne 0) { throw 'Sorter report delivery status unavailable.' }
    $deliveryStatus = $pending.Stdout | ConvertFrom-Json
    foreach ($reportItem in @($deliveryStatus.pendingReports | Select-Object -First 20)) {
      $delivered = Submit-SortNotification -ReportId $reportItem.reportId -Summary $reportItem.summary
      $deliveryOutcome = if ($delivered) { 'delivered' } else { 'failed' }
      $receipt = Invoke-SortChild -Executable $node -Arguments @($tsx, $script, 'delivery', "--report=$($reportItem.reportId)", "--outcome=$deliveryOutcome") -Environment $environment -WorkingDirectory $repoRoot -TimeoutSeconds 900
      if ($receipt.ExitCode -ne 0) { throw 'Sorter delivery receipt unavailable; report remains pending.' }
    }
  } catch {
    if ($Command -ne 'run') { throw }
    $runStatus = if ($runCompleted) { 'Sorter run completed successfully' } else { 'No sorter run was due' }
    Write-Warning "$runStatus; report delivery is still pending. Run roadmap:sort:secure notify to retry delivery."
  }
}
