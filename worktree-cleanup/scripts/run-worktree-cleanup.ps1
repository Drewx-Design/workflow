param([string] $NodePath, [string] $GitPath, [string] $GhPath)
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
# Test-only overrides apply only under the harness sentinel. The scheduled task
# inherits the user environment, so a stale variable must not change a real run.
function Get-TestOverride([string] $Name) {
  if ($env:WORKTREE_CLEANUP_TEST_OVERRIDES -ne '1') { return $null }
  return [Environment]::GetEnvironmentVariable($Name)
}
$started =[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$script:SoftBudgetMs = 4500000 # 75-minute soft budget < 78-minute child kill < 80-minute task limit.
$root = $PSScriptRoot
$launcherLock = $null
$preparationLock = $null
$exitCode = 1
$failureStage = 'launcher'
$childJob = $null

function Resolve-Executable([string] $ExplicitPath, [string] $Name) {
  $path = $ExplicitPath
  if ([string]::IsNullOrWhiteSpace($path)) { $path = (Get-Command $Name -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
  if (-not [IO.Path]::IsPathRooted($path) -or [IO.Path]::GetExtension($path) -ne '.exe' -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Executable unavailable: $Name (an absolute .exe is required)."
  }
  return (Resolve-Path -LiteralPath $path).ProviderPath
}
function Get-LockPort([string] $Identity) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Identity)) } finally { $sha.Dispose() }
  return 20000 + (([uint64]$bytes[0] * 16777216 + [uint64]$bytes[1] * 65536 + [uint64]$bytes[2] * 256 + [uint64]$bytes[3]) % 20000)
}
function Take-Lock([int] $Port, [switch] $WaitForPreparation) {
  $waitBudget = 900000 # Preparation may wait at most 15 minutes.
  $value = Get-TestOverride 'WORKTREE_CLEANUP_LOCK_WAIT_MS'
  if ($WaitForPreparation -and $value) {
    $override = 0
    if (-not [int]::TryParse($value, [ref]$override) -or $override -le 0) { throw 'Invalid test lock wait budget.' }
    $waitBudget = [Math]::Min($waitBudget, $override)
  }
  $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $waitBudget
  $announced = $false
  $reason = 'Single-instance lock occupied; no launcher run started.'
  while ($true) {
    if ($WaitForPreparation -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $deadline) { throw $reason }
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
    $listener.Server.ExclusiveAddressUse = $true
    try { $listener.Start(); return $listener }
    catch {
      $socketError = $_.Exception
      while ($socketError.InnerException) { $socketError = $socketError.InnerException }
      $listener.Stop()
      if (-not $WaitForPreparation -or $socketError -isnot [Net.Sockets.SocketException] -or
          $socketError.SocketErrorCode -ne [Net.Sockets.SocketError]::AddressAlreadyInUse) { throw $reason }
      $remaining = $deadline - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      if ($remaining -le 0) { throw $reason }
      if (-not $announced) { [Console]::WriteLine('Waiting for cleanup preparation lock.'); $announced = $true }
      Start-Sleep -Milliseconds ([int][Math]::Min(1000, $remaining))
    }
  }
}
function Quote-ProcessArgument([string] $Argument) {
  # Windows argv quoting: double backslashes before quotes and the closing quote.
  $escaped = $Argument -replace '(\\*)"', '$1$1\"'
  return '"' + ($escaped -replace '(\\+)$', '$1$1') + '"'
}
function Invoke-Git([string[]] $GitArguments) {
  Assert-Time
  # Calls may carry -C and -c options before the command verb.
  $index = 0
  while ($GitArguments[$index] -in @('-C', '-c')) { $index += 2 }
  $verb = $GitArguments[$index]
  $timeout = 60000
  if ($verb -eq 'fetch') { $timeout = 120000 }
  # Test-only override; scheduled runs leave this unset.
  $value = Get-TestOverride 'WORKTREE_CLEANUP_GIT_TIMEOUT_MS'
  if ($value) {
    $override = 0
    if (-not [int]::TryParse($value, [ref]$override) -or $override -le 0) { throw 'Invalid test Git timeout.' }
    $timeout = [Math]::Min($timeout, $override)
  }
  $deadline = [Math]::Min($started + $script:SoftBudgetMs, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $timeout)
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $script:git
  $info.Arguments = ((@('--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', $script:repository) + $GitArguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' ')
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = $utf8
  $info.StandardErrorEncoding = $utf8
  $info.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $info
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
    try {
      $output = @(while ($null -ne ($line = $reader.ReadLine())) { $line })
      return $output
    } finally { $reader.Dispose() }
  } finally { $process.Dispose() }
}
function Assert-Time {
  if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $started -ge $script:SoftBudgetMs) { throw 'Soft deadline reached during launcher preparation.' }
}
function Write-LauncherFailure([string] $Reason, [string] $Stage = 'launcher') {
  $id = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss.fffZ') + '-' + [Guid]::NewGuid().ToString()
  $reportDirectory = Join-Path $root 'reports'
  [IO.Directory]::CreateDirectory($reportDirectory) | Out-Null
  $reportPath = Join-Path $reportDirectory ($id + '.md')
  $detail = 'No cleanup stages started.'
  if ($Stage -eq 'timeout') { $detail = 'Cleanup did not finish within the launcher deadline; inspect prior run evidence before retrying.' }
  $text = "# Worktree cleanup`n`nHeld: unknown; oldest held: unknown.`nArchives: unknown; total size: unknown; oldest: unknown.`nRescue PR: none`n`nLauncher failed: $Reason`n$detail`n"
  [IO.File]::WriteAllText($reportPath, $text, $utf8)
  $record = @{ version = 1; runId = $id; startedAt = $started; finishedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); dryRun = $false; status = 'failed'; stage = $Stage; error = $Reason; worktrees = @(); reportPath = $reportPath }
  $journal = Join-Path $root 'journal.jsonl'
  if ([IO.File]::Exists($journal)) {
    $existing = [IO.File]::ReadAllText($journal, $utf8)
    # Never truncate: another writer may have appended after this read.
    if ($existing.Length -gt 0 -and -not $existing.EndsWith("`n")) { [IO.File]::AppendAllText($journal, "`n", $utf8) }
  }
  [IO.File]::AppendAllText($journal, (($record | ConvertTo-Json -Compress -Depth 5) + "`n"), $utf8)
  Write-Output "Cleanup failed. Report: $reportPath"
  # Tests exercise failure paths on purpose; they set this so no real toast appears.
  if ($env:WORKTREE_CLEANUP_NO_TOAST -eq '1') { return }
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null
    $toast = New-Object Windows.Data.Xml.Dom.XmlDocument
    $toast.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">Workflow tools worktree cleanup</text><text id="2">The launcher failed. Read the latest cleanup report.</text></binding></visual></toast>')
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Workflow tools worktree cleanup').Show([Windows.UI.Notifications.ToastNotification]::new($toast))
  } catch { # A toast is best effort; the durable report is authoritative.
  }
}
try {
  $childTimeout = $script:SoftBudgetMs + 180000 # 75-minute soft budget < 78-minute child kill < 80-minute task limit.
  $value = Get-TestOverride 'WORKTREE_CLEANUP_CHILD_TIMEOUT_MS'
  if ($value) {
    $override = 0
    if (-not [int]::TryParse($value, [ref]$override) -or $override -le 0) { throw 'Invalid test child timeout.' }
    $childTimeout = [Math]::Min($childTimeout, $override)
  }
  $record = Get-Content -LiteralPath (Join-Path $root 'installation.json') -Raw | ConvertFrom-Json
  $actualHash = Get-Sha256Hex $PSCommandPath
  if ($record.version -ne 1 -or $actualHash -cne $record.launcherSha256) { throw 'Installed launcher SHA-256 mismatch; reinstall from reviewed code.' }
  $repository = (Resolve-Path -LiteralPath $record.repositoryPath).ProviderPath.TrimEnd([char[]]'\/')
  $identity = $repository.Replace('\', '/').ToLowerInvariant()
  # The launcher lock spans preparation and the child. The run lock protects
  # runner refresh from releases executing its files, then the child joins the
  # JS admission queue. The launcher never reads report-root owner metadata.
  $launcherLock = Take-Lock (Get-LockPort ($identity + '|launcher'))
  $preparationLock = Take-Lock (Get-LockPort $identity) -WaitForPreparation
  $node = Resolve-Executable $NodePath 'node.exe'
  $git = Resolve-Executable $GitPath 'git.exe'
  $gh = Resolve-Executable $GhPath 'gh.exe'
  Get-ChildItem Env:GIT_* | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GIT_OPTIONAL_LOCKS = '0'
  # U4's gh credential helper resolves to this same absolute executable directory.
  $env:PATH = (Split-Path -Parent $gh) + ';' + $env:PATH
  $common = @(Invoke-Git @('rev-parse', '--path-format=absolute', '--git-common-dir'))
  if ($common.Count -ne 1 -or -not [IO.Path]::GetFullPath($common[0]).Equals((Join-Path $repository '.git'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Installed primary repository identity changed.' }
  $runner = Join-Path $repository '.worktrees\.worktree-cleanup-runner'
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
  Assert-Time
  Invoke-Git @('fetch', '--no-recurse-submodules', 'origin', 'main') | Out-Null
  Assert-Time
  if (Test-Path -LiteralPath $runner) {
    Invoke-Git @('-C', $runner, '-c', 'core.hooksPath=NUL', 'checkout', '--detach', 'origin/main') | Out-Null
  } else {
    Invoke-Git @('-c', 'core.hooksPath=NUL', 'worktree', 'add', '--detach', $runner, 'origin/main') | Out-Null
  }
  $head = @(Invoke-Git @('-C', $runner, 'rev-parse', 'HEAD'))
  $main = @(Invoke-Git @('rev-parse', 'origin/main'))
  $branch = @(Invoke-Git @('-C', $runner, 'rev-parse', '--abbrev-ref', 'HEAD'))
  if ($head.Count -ne 1 -or $head[0] -ne $main[0] -or $branch[0] -ne 'HEAD') { throw 'Runner is not detached at origin/main.' }
  Assert-Time
  $remaining = $script:SoftBudgetMs - ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $started)
  # Test-only cap on the remaining budget; scheduled runs leave this unset.
  $value = Get-TestOverride 'WORKTREE_CLEANUP_REMAINING_MS'
  if ($value) {
    $override = 0
    if (-not [int]::TryParse($value, [ref]$override) -or $override -lt 0) { throw 'Invalid test remaining budget.' }
    $remaining = [Math]::Min($remaining, $override)
  }
  # The CLI needs its 2-minute tail reserve plus its 3-minute removal floor.
  if ($remaining -le 300000) { throw 'Insufficient soft budget after launcher preparation; more than 300000 ms required for tail reserve and removal floor.' }
  $journalPath = Join-Path $root 'journal.jsonl'
  $runId = [Guid]::NewGuid().ToString()
  # JOB_LIST assigns the job atomically at process creation (Windows 10+).
  # The job handle is not inheritable. If PowerShell dies, its last handle closes
  # and Windows kills every descendant. Unsupported/denied assignment fails closed.
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public sealed class CleanupChildJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort ShowWindow, ReservedSize;
    public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
    public StartupInfo Info;
    public IntPtr Attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  IntPtr job, process;
  static void Check(bool success, string operation) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  public CleanupChildJob() {
    job = CreateJobObject(IntPtr.Zero, null);
    Check(job != IntPtr.Zero, "Create cleanup Job Object");
    try {
      var limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))), "Set kill-on-close job limit");
    } catch { Dispose(); throw; }
  }
  public void Start(string executable, string command, string directory) {
    IntPtr size = IntPtr.Zero, list = IntPtr.Zero, value = IntPtr.Zero;
    bool initialized = false;
    try {
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Size job assignment attributes");
      list = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(list, 1, 0, ref size), "Initialize job assignment attributes");
      initialized = true;
      value = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(value, job);
      Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x2000D), value, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Set atomic child job assignment");
      var startup = new StartupInfoEx();
      startup.Info.Size = Marshal.SizeOf(typeof(StartupInfoEx));
      startup.Info.Flags = 0x100; // STARTF_USESTDHANDLES: retain console/log output.
      startup.Info.Input = GetStdHandle(-10);
      startup.Info.Output = GetStdHandle(-11);
      startup.Info.Error = GetStdHandle(-12);
      startup.Attributes = list;
      ProcessInfo child;
      // EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW
      Check(CreateProcess(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true,
        0x08080000, IntPtr.Zero, directory, ref startup, out child), "Create child assigned to cleanup job");
      process = child.Process;
      CloseHandle(child.Thread);
    } finally {
      if (initialized) DeleteProcThreadAttributeList(list);
      if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
      if (value != IntPtr.Zero) Marshal.FreeHGlobal(value);
    }
  }
  public bool Wait(int milliseconds) {
    uint result = WaitForSingleObject(process, (uint)milliseconds);
    if (result == 0) return true;
    if (result == 258) return false;
    throw new Win32Exception(Marshal.GetLastWin32Error(), "Wait for cleanup child");
  }
  public int ExitCode() {
    uint code;
    Check(GetExitCodeProcess(process, out code), "Read cleanup exit code");
    return unchecked((int)code);
  }
  public void Kill() {
    Check(TerminateJobObject(job, 1), "Terminate cleanup process tree");
    if (!Wait(5000)) throw new Exception("Cleanup process tree termination did not finish");
  }
  public void Dispose() {
    if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
  }
}
'@
  $childJob = New-Object CleanupChildJob
  $preparationLock.Stop(); $preparationLock = $null
  Push-Location -LiteralPath $runner
  try {
    $childRemaining = [int][Math]::Max(0, $started + $childTimeout - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    if ($childRemaining -eq 0) { $failureStage = 'timeout'; throw "Cleanup overran launcher hard limit of $childTimeout ms before child start." }
    $command = ((@($node, 'scripts/worktree-cleanup.mjs', 'run', '--scheduled-nightly', '--repo', $repository, '--runner', $runner, '--git', $git, '--gh', $gh, '--report-root', $root, '--run-id', $runId, '--soft-timeout-ms', [string]$remaining) | ForEach-Object { Quote-ProcessArgument $_ }) -join ' ')
    $childJob.Start($node, $command, $runner)
    $childRemaining = [int][Math]::Max(0, $started + $childTimeout - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    if (-not $childJob.Wait($childRemaining)) {
      $failureStage = 'timeout'
      try { $childJob.Kill() }
      catch { throw "Cleanup child overran launcher hard limit of $childTimeout ms; termination failed: $($_.Exception.Message)" }
      throw "Cleanup child overran launcher hard limit of $childTimeout ms; process tree terminated."
    }
    $exitCode = $childJob.ExitCode()
    $childJob.Dispose(); $childJob = $null
    $reported = $false
    if (Test-Path -LiteralPath $journalPath) {
      foreach ($line in [IO.File]::ReadLines($journalPath, $utf8)) {
        try {
          $row = $line | ConvertFrom-Json -ErrorAction Stop
          if ($row.version -eq 1 -and $row.runId -ceq $runId -and $row.status -in @('completed', 'failed') -and $row.worktrees -is [Array]) { $reported = $true }
        } catch { # Malformed rows are gaps, not a reason to discard other runs.
        }
      }
    }
    if (-not $reported) { throw 'Runner exited before writing a report.' }
  } finally { Pop-Location }
} catch {
  $reason = $_.Exception.Message
  if ($childJob) { $childJob.Dispose(); $childJob = $null }
  Write-LauncherFailure $reason $failureStage
  $exitCode = 1
} finally {
  if ($childJob) { $childJob.Dispose() }
  if ($preparationLock) { $preparationLock.Stop() }
  if ($launcherLock) { $launcherLock.Stop() }
}
exit $exitCode
