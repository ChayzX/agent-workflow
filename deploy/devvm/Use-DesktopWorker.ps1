[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $DesktopUser,
    [string] $DataRoot = 'E:\AIDevVM-Desktop',
    [string] $Python = 'C:\Python313\python.exe',
    [switch] $Resume
)

$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script in an elevated PowerShell from the signed-in desktop account.'
}
$task = 'AIDevVM-Worker'
$app = Join-Path $env:ProgramData 'AIDevVM'
$configPath = Join-Path $app 'host.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$owner = Get-LocalUser -Name $DesktopUser
$sshAccount = Get-LocalUser -Name aidevvm
if ($owner.SID -ne $principal.Identity.User -or (Get-Process -Id $PID).SessionId -eq 0) {
    throw 'Start this repair from the specified desktop account while it is signed in.'
}
$spool = Join-Path $DataRoot 'spool'
if (Test-Path -LiteralPath $DataRoot) {
    if (!$Resume -or (Get-ChildItem -LiteralPath $DataRoot -Force | Where-Object Name -NE 'spool') -or
        (Get-ChildItem -LiteralPath $spool -Force -ErrorAction SilentlyContinue)) {
        throw "Desktop worker destination already exists and is not empty: $DataRoot"
    }
}
$leases = Join-Path $config.root 'leases'
if ((Test-Path -LiteralPath $leases) -and (Get-ChildItem -LiteralPath $leases -Directory)) {
    throw 'Destroy the managed leases before moving the worker to another Windows account.'
}

function Set-Access {
    param([string] $Path, [string[]] $Ace, [switch] $Protect)
    # Build the list explicitly: an empty if/else result becomes $null and would pass "" to icacls.
    $arguments = [Collections.Generic.List[string]]::new()
    $arguments.Add($Path)
    if ($Protect) { $arguments.Add('/inheritance:r') }
    $arguments.Add('/grant:r')
    foreach ($entry in $Ace) { $arguments.Add($entry) }
    & icacls.exe $arguments.ToArray()
    if ($LASTEXITCODE -ne 0) { throw "Could not update permissions on $Path" }
}

New-Item -ItemType Directory -Path $DataRoot,$spool -Force | Out-Null
$ownerRead = '*{0}:(OI)(CI)RX' -f $owner.SID.Value
$ownerModify = '*{0}:(OI)(CI)M' -f $owner.SID.Value
$sshTraverse = '*{0}:RX' -f $sshAccount.SID.Value
$sshSpool = '*{0}:(OI)(CI)M' -f $sshAccount.SID.Value
Set-Access $app @($ownerRead)
Set-Access $DataRoot @('*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F',$ownerModify,$sshTraverse) -Protect
Set-Access $spool @($sshSpool)

Stop-ScheduledTask -TaskName $task
$config.root = $DataRoot
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding ASCII
$windowsPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Python "{1}" -App "{2}" -Data "{3}"' -f (Join-Path $app 'Start-Worker.ps1'),$Python,$app,$DataRoot
$userName = "$env:COMPUTERNAME\$DesktopUser"
$settings = @{
    ExecutionTimeLimit = [timespan]::Zero
    StartWhenAvailable = $true
    AllowStartIfOnBatteries = $true
    DontStopIfGoingOnBatteries = $true
    MultipleInstances = 'IgnoreNew'
    RestartCount = 999
    RestartInterval = New-TimeSpan -Minutes 1
}
$job = @{
    TaskName = $task
    Action = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument $arguments -WorkingDirectory $app
    Trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
    Settings = New-ScheduledTaskSettingsSet @settings
    Principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
}
Register-ScheduledTask @job -Force | Out-Null
Start-ScheduledTask -TaskName $task
Get-ScheduledTask -TaskName $task | Select-Object TaskName,State
