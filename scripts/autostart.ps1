param([ValidateSet('enable','disable')][string]$Action,[string]$NodePath,[string]$CliPath)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\ScheduledTasks\ScheduledTasks.psd1') -ErrorAction Stop
$name = 'WeChatBot-CodexBridge'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($Action -eq 'disable') {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($task) {
    if ($task.Principal.UserId -ne $identity) { throw 'Task belongs to another user' }
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'Task removal could not be verified' }
  }
  Write-Output 'WeChatBot logon startup disabled'
  exit
}
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'Task already exists; refusing to overwrite' }
$node = (Resolve-Path -LiteralPath $NodePath).Path
$cli = (Resolve-Path -LiteralPath $CliPath).Path
$launcher = Join-Path $PSScriptRoot 'start-hidden.ps1'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcher + '" -NodePath "' + $node + '" -CliPath "' + $cli + '"'
$actionDef = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory (Split-Path -Parent $cli)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $actionDef -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
$saved = Get-ScheduledTask -TaskName $name
if ($saved.Principal.UserId -ne $identity -or $saved.Actions[0].Arguments -ne $arguments) { throw 'Saved autostart task does not match this installation' }
Write-Output 'WeChatBot logon startup enabled for the current user'
