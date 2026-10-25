param([switch] $RegisterDisabled)
$ErrorActionPreference = 'Stop'

function Get-SortTaskXml {
  param([string] $Repository, [string] $UserId)
  $userXml = [Security.SecurityElement]::Escape($UserId)
  $workingXml = [Security.SecurityElement]::Escape($Repository)
  $powershellXml = [Security.SecurityElement]::Escape((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
  $wrapperXml = [Security.SecurityElement]::Escape((Join-Path $Repository 'scripts\run-github-issue-roadmap-sort.ps1'))
  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Workflow tools daily roadmap sorting and bounded continuation; activation requires live proof.</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger><Repetition><Interval>PT1H</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T09:15:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>
    <LogonTrigger><Enabled>true</Enabled><UserId>$userXml</UserId><Delay>PT1M</Delay></LogonTrigger>
  </Triggers>
  <Principals><Principal id="Owner"><UserId>$userXml</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT3H3M</ExecutionTimeLimit><Enabled>false</Enabled><Hidden>true</Hidden></Settings>
  <Actions Context="Owner"><Exec><Command>$powershellXml</Command><Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File &quot;$wrapperXml&quot; -Command run -Scheduled -GlmSlot secondary</Arguments><WorkingDirectory>$workingXml</WorkingDirectory></Exec></Actions>
</Task>
"@
}

if ([TimeZoneInfo]::Local.Id -ne 'Eastern Standard Time') { throw 'The installed host must use Eastern Standard Time (including automatic daylight saving changes).' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$xml = Get-SortTaskXml -Repository $repoRoot -UserId $identity
if (-not $RegisterDisabled) { Write-Output $xml; exit 0 }
$taskName = 'Workflow tools automatic roadmap sorting'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'The sorter task already exists; preserve its activation state and inspect it before changing installation.' }
# No stored password and no unattended activation here. Logged-out runs wait until
# the owner's next login; locked, logged-in sessions use the same DPAPI identity.
Register-ScheduledTask -TaskName $taskName -Xml $xml | Out-Null
Write-Output 'Sorter task registered disabled. Complete adoption, native readback, stable-repeat and installed-notification proof before enabling it.'
