param(
  [Parameter(Mandatory = $true, Position = 0)] [string] $Path,
  [Alias('owner-session', '-owner-session')] [string] $OwnerSession,
  [string] $NodePath
)
$ErrorActionPreference = 'Stop'
try {
  $record = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installation.json') -Raw | ConvertFrom-Json
  if ($record.version -ne 1) { throw 'Unsupported cleanup installation metadata; reinstall from reviewed code.' }
  $repository = (Resolve-Path -LiteralPath $record.repositoryPath).ProviderPath.TrimEnd([char[]]'\/')
  $runner = Join-Path $repository '.worktrees\.worktree-cleanup-runner'
  $scriptPath = Join-Path $runner 'scripts\worktree-cleanup.mjs'
  $queuePath = Join-Path $runner 'scripts\lib\worktree-cleanup\report.mjs'
  # Recognize the reviewed CLI's explicit release dispatch, not a mention in a
  # usage string or the older --release-unresolved-doubt flag. Never refresh or
  # run code from the primary checkout here; the installer and launcher refresh.
  # U4's named async export admitRunLock is the stable admission-queue marker.
  # A mention in a comment or a differently cased export does not qualify.
  if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf) -or
      [IO.File]::ReadAllText($scriptPath) -cnotmatch '(?m)^\s*if\s*\(\s*command\s*===\s*([''"])release\1\s*\)' -or
      -not (Test-Path -LiteralPath $queuePath -PathType Leaf) -or
      [IO.File]::ReadAllText($queuePath) -cnotmatch '(?m)^\s*export\s+async\s+function\s+admitRunLock\s*\(') {
    Write-Output (@{ outcome = 'refused'; reasonCode = 'runner-outdated'; exitCode = 3; targetPath = $Path } | ConvertTo-Json -Compress)
    exit 3
  }
  $node = $NodePath
  if ([string]::IsNullOrWhiteSpace($node)) { $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
  if (-not [IO.Path]::IsPathRooted($node) -or [IO.Path]::GetExtension($node) -ne '.exe' -or -not (Test-Path -LiteralPath $node -PathType Leaf)) {
    throw 'Executable unavailable: node.exe (an absolute .exe is required).'
  }
  $arguments = @($scriptPath, 'release', $Path, '--repo', $repository, '--runner', $runner, '--report-root', $PSScriptRoot)
  if ($PSBoundParameters.ContainsKey('OwnerSession')) { $arguments += @('--owner-session', $OwnerSession) }
  & $node @arguments
  exit $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
