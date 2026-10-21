# Registers the "herdr coordinator watchers" task: at logon, then every 10 minutes, relaunch the
# watcher of each repository that still has live workers, behind its watcher_lost hold.
# Every lane sees the repository hold; one authorized go from the user clears it.
# Nothing is sent to any worker until then.
# Run again to update; -Remove unregisters it.
param([switch]$Remove)

$name = 'herdr coordinator watchers'
if ($Remove) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    return
}
$python = (Get-Command python.exe).Source
$pythonw = Join-Path (Split-Path $python) 'pythonw.exe'
$script = Join-Path $PSScriptRoot 'herdr_coord.py'
$action = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$script`" revive-watchers"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 10)).Repetition
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Relaunch herdr-coordinator watchers after a reboot, each behind a hold until the user says go.' `
    -Force | Out-Null
Get-ScheduledTask -TaskName $name | Select-Object TaskName, State
