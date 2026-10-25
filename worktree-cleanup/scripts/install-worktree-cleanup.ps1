param(
  [string] $Repository = (Split-Path -Parent $PSScriptRoot),
  [string] $InstallRoot = (Join-Path $env:LOCALAPPDATA 'WorkflowTools\worktree-cleanup'),
  [switch] $PrintXml,
  [switch] $InstallOnly
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
# .NET, not Get-FileHash: that cmdlet is script-defined in a module that fails
# to load when powershell.exe inherits PowerShell 7's PSModulePath.
function Get-Sha256Hex([string] $Path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}
$taskName = 'Workflow tools worktree cleanup'
if ($PrintXml -and $InstallOnly) { throw 'Choose PrintXml or InstallOnly.' }
$repositoryPath = (Resolve-Path -LiteralPath $Repository).ProviderPath.TrimEnd([char[]]'\/')
$installPath = [IO.Path]::GetFullPath($InstallRoot).TrimEnd([char[]]'\/')
if ($installPath.Equals($repositoryPath, [StringComparison]::OrdinalIgnoreCase) -or
    $installPath.StartsWith($repositoryPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'InstallRoot must be outside the repository.'
}
$git = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if (-not [IO.Path]::IsPathRooted($git)) { throw 'Git must resolve to an absolute executable.' }
$env:GIT_OPTIONAL_LOCKS = '0'
Get-ChildItem Env:GIT_* | Where-Object { $_.Name -ne 'GIT_OPTIONAL_LOCKS' } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
function Invoke-Git([string[]] $GitArguments) {
  $index = 0
  while ($GitArguments[$index] -in @('-C', '-c')) { $index += 2 }
  $verb = $GitArguments[$index]
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $git
  # Quote every Windows argv entry, including trailing backslashes.
  $info.Arguments = ((@('--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', $repositoryPath) + $GitArguments | ForEach-Object {
    $escaped = $_ -replace '(\\*)"', '$1$1\"'
    '"' + ($escaped -replace '(\\+)$', '$1$1') + '"'
  }) -join ' ')
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = $utf8
  $info.StandardErrorEncoding = $utf8
  $info.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $info
  $timeout = 60000
  if ($verb -eq 'fetch') { $timeout = 120000 }
  $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $timeout
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $remaining = [int][Math]::Max(0, $deadline - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    $finished = $process.WaitForExit($remaining)
    if ($finished) {
      $remaining = [int][Math]::Max(0, $deadline - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
      $finished = [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), $remaining)
    }
    if (-not $finished) {
      $killExit = 'unknown'
      try { & "$env:SystemRoot\System32\taskkill.exe" /T /F /PID $process.Id > $null 2>&1; $killExit = $LASTEXITCODE }
      finally { throw "Git command timed out: $verb (taskkill exit $killExit)" }
    }
    [Console]::Error.Write($stderr.Result)
    if ($process.ExitCode -ne 0) { throw "Git command failed: $verb (exit $($process.ExitCode))" }
    $reader = New-Object IO.StringReader($stdout.Result)
    try { return @(while ($null -ne ($line = $reader.ReadLine())) { $line }) }
    finally { $reader.Dispose() }
  } finally { $process.Dispose() }
}
$common = @(Invoke-Git @('rev-parse', '--path-format=absolute', '--git-common-dir'))
if ($common.Count -ne 1 -or
    -not [IO.Path]::GetFullPath($common[0]).Equals((Join-Path $repositoryPath '.git'), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Repository must be a validated primary checkout, not a linked worktree or bare repository.'
}
$launcher = Join-Path $installPath 'run-worktree-cleanup.ps1'
$userXml = [Security.SecurityElement]::Escape([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$powershellXml = [Security.SecurityElement]::Escape((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
$launcherXml = [Security.SecurityElement]::Escape($launcher)
$workingXml = [Security.SecurityElement]::Escape($installPath)
# No encoding in the declaration: Register-ScheduledTask receives this as a
# UTF-16 string and refuses a UTF-8 declaration ("unable to switch the
# encoding"), while task.xml below is written as UTF-8 bytes.
$xml = @"
<?xml version="1.0"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Workflow tools daily worktree cleanup from reviewed origin/main.</Description></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>2026-01-01T03:00:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
  <Principals><Principal id="Owner"><UserId>$userXml</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT80M</ExecutionTimeLimit><Enabled>true</Enabled><Hidden>true</Hidden></Settings>
  <Actions Context="Owner"><Exec><Command>$powershellXml</Command><Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File &quot;$launcherXml&quot;</Arguments><WorkingDirectory>$workingXml</WorkingDirectory></Exec></Actions>
</Task>
"@
# PrintXml has no installation or scheduler side effects.
if ($PrintXml) { Write-Output $xml; exit 0 }
if (-not $InstallOnly -and (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
  throw 'Task already exists. Disable and uninstall it before replacing the installed launcher.'
}
[IO.Directory]::CreateDirectory($installPath) | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run-worktree-cleanup.ps1') -Destination $launcher
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'release-worktree.ps1') -Destination (Join-Path $installPath 'release-worktree.ps1')
$record = @{ version = 1; repositoryPath = $repositoryPath; launcherSha256 = (Get-Sha256Hex $launcher) }
[IO.File]::WriteAllText((Join-Path $installPath 'installation.json'), (($record | ConvertTo-Json) + "`n"), $utf8)
[IO.File]::WriteAllText((Join-Path $installPath 'task.xml'), $xml, $utf8)
# Match the launcher's refresh checks before touching an existing runner. Dirty,
# redirected or foreign runners are preserved; installation can still finish.
try {
  $runner = Join-Path $repositoryPath '.worktrees\.worktree-cleanup-runner'
  $runnerParent = Split-Path -Parent $runner
  if (Test-Path -LiteralPath $runnerParent) {
    $parentItem = Get-Item -LiteralPath $runnerParent -Force
    if (-not $parentItem.PSIsContainer -or ($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Runner parent is redirected or is not a directory.' }
  }
  if (Test-Path -LiteralPath $runner) {
    $item = Get-Item -LiteralPath $runner -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Runner is redirected.' }
    $runnerCommon = @(Invoke-Git @('-C', $runner, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    if ($runnerCommon.Count -ne 1 -or $runnerCommon[0] -ne $common[0]) { throw 'Runner belongs to another repository.' }
    $registered = @(Invoke-Git @('worktree', 'list', '--porcelain'))
    if (-not ($registered | Where-Object { $_ -eq ('worktree ' + $runner.Replace('\', '/')) })) { throw 'Runner is not registered at its expected path.' }
    $dirty = @(Invoke-Git @('-C', $runner, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'))
    if ($dirty.Count -ne 0) { throw 'Runner is dirty; preserve and inspect its files before retrying.' }
  }
  Invoke-Git @('fetch', '--no-recurse-submodules', 'origin', 'main') | Out-Null
  if (Test-Path -LiteralPath $runner) {
    Invoke-Git @('-C', $runner, '-c', 'core.hooksPath=NUL', 'checkout', '--detach', 'origin/main') | Out-Null
  } else {
    Invoke-Git @('-c', 'core.hooksPath=NUL', 'worktree', 'add', '--detach', $runner, 'origin/main') | Out-Null
  }
  $head = @(Invoke-Git @('-C', $runner, 'rev-parse', 'HEAD'))
  $main = @(Invoke-Git @('rev-parse', 'origin/main'))
  $branch = @(Invoke-Git @('-C', $runner, 'rev-parse', '--abbrev-ref', 'HEAD'))
  if ($head.Count -ne 1 -or $head[0] -ne $main[0] -or $branch[0] -ne 'HEAD') { throw 'Runner is not detached at origin/main.' }
  Write-Output 'Runner refreshed to detached origin/main.'
} catch {
  Write-Output ('Runner refresh deferred: ' + $_.Exception.Message + ' The next nightly run will refresh it; releases refuse until then.')
}
if ($InstallOnly) { Write-Output 'Launcher installed; no scheduled task registered.'; exit 0 }
Register-ScheduledTask -TaskName $taskName -Xml $xml | Out-Null
Write-Output 'Workflow tools worktree cleanup registered enabled, daily at 03:00 local time while the owner is logged in.'
