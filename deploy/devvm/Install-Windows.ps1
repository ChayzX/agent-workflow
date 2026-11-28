[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Assets,
    [Parameter(Mandatory)] [string] $ControllerKeyFile,
    [Parameter(Mandatory)] [string] $Result,
    [string] $DataRoot = 'E:\AIDevVM',
    [string] $Python = 'C:\Python313\python.exe',
    [switch] $Resume
)

$ErrorActionPreference = 'Stop'
$app = Join-Path $env:ProgramData 'AIDevVM'
$sshDirectory = Join-Path $env:ProgramData 'ssh'
$sshLogs = Join-Path $sshDirectory 'logs'
$sshConfig = Join-Path $sshDirectory 'sshd_config'
$systemOpenSsh = Join-Path $env:WINDIR 'System32\OpenSSH'
$winSshd = Join-Path $systemOpenSsh 'sshd.exe'
$winKeygen = Join-Path $systemOpenSsh 'ssh-keygen.exe'
$hostKey = Join-Path $sshDirectory 'devvm_host_ed25519_key'
$keyFile = Join-Path $app 'controller.keys'
$taskName = 'AIDevVM-Worker'
$sshTaskName = 'AIDevVM-OpenSSH'
$account = 'aidevvm'
$vbox = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
$provisioningOpenSsh = $false

function Invoke-Checked {
    param([string] $Executable, [string[]] $Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable exited $LASTEXITCODE" }
}

function Set-DirectoryPermissions {
    param([string] $Directory, [string] $Sid, [string] $Rights)
    $grant = '*{0}:(OI)(CI){1}' -f $Sid,$Rights
    Invoke-Checked icacls.exe @($Directory, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F',
        '*S-1-5-32-544:(OI)(CI)F', $grant)
}

function Grant-WorkerBatchLogon {
    param([Security.Principal.SecurityIdentifier] $UserSid)
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AiDevVmAccountRights {
    [StructLayout(LayoutKind.Sequential)]
    private struct Attributes {
        public int Length;
        public IntPtr RootDirectory, ObjectName;
        public int Flags;
        public IntPtr SecurityDescriptor, SecurityQualityOfService;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Right {
        public ushort Length, MaximumLength;
        [MarshalAs(UnmanagedType.LPWStr)] public string Value;
    }
    [DllImport("advapi32.dll")]
    private static extern uint LsaOpenPolicy(IntPtr system, ref Attributes attributes, uint access, out IntPtr handle);
    [DllImport("advapi32.dll")]
    private static extern uint LsaAddAccountRights(IntPtr handle, byte[] sid, Right[] rights, uint count);
    [DllImport("advapi32.dll")]
    private static extern uint LsaNtStatusToWinError(uint status);
    [DllImport("advapi32.dll")]
    private static extern uint LsaClose(IntPtr handle);

    public static void AllowBatchLogon(byte[] sid) {
        var attributes = new Attributes();
        attributes.Length = Marshal.SizeOf(typeof(Attributes));
        IntPtr handle;
        uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, 0x00000810, out handle);
        if (status != 0) throw new Win32Exception((int)LsaNtStatusToWinError(status));
        try {
            const string name = "SeBatchLogonRight";
            var right = new Right { Length = (ushort)(name.Length * 2),
                                    MaximumLength = (ushort)((name.Length + 1) * 2), Value = name };
            status = LsaAddAccountRights(handle, sid, new[] { right }, 1);
            if (status != 0) throw new Win32Exception((int)LsaNtStatusToWinError(status));
        } finally { LsaClose(handle); }
    }
}
'@
    $sidBytes = [byte[]]::new($UserSid.BinaryLength)
    $UserSid.GetBinaryForm($sidBytes, 0)
    [AiDevVmAccountRights]::AllowBatchLogon($sidBytes)
}

function Start-OpenSshAtBoot {
    $launcher = Join-Path $app 'Start-OpenSSH.ps1'
    @'
param([string] $Sshd, [string] $Config, [string] $LogDir)
$ErrorActionPreference = 'Continue'
$log = Join-Path $LogDir 'devvm-openssh.log'
& $Sshd -D -e -f $Config 2>> $log
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $launcher -Encoding ASCII

    $winPS = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $args = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Sshd "{1}" -Config "{2}" -LogDir "{3}"' -f $launcher,$winSshd,$sshConfig,$sshLogs
    $taskSettings = @{
        ExecutionTimeLimit = [timespan]::Zero
        StartWhenAvailable = $true
        AllowStartIfOnBatteries = $true
        DontStopIfGoingOnBatteries = $true
        MultipleInstances = 'IgnoreNew'
        RestartCount = 999
        RestartInterval = New-TimeSpan -Minutes 1
    }
    $fallback = @{
        TaskName = $sshTaskName
        Action = New-ScheduledTaskAction -Execute $winPS -Argument $args -WorkingDirectory $app
        Trigger = New-ScheduledTaskTrigger -AtStartup
        Settings = New-ScheduledTaskSettingsSet @taskSettings
        Principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    }
    Register-ScheduledTask @fallback -Force | Out-Null
    Start-ScheduledTask -TaskName $sshTaskName
    $until = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 500
        $listener = Get-NetTCPConnection -LocalPort 2224 -State Listen -ErrorAction SilentlyContinue
    } until ($listener -or (Get-Date) -gt $until)
    if (!$listener) {
        $foregroundLog = Join-Path $sshLogs 'devvm-openssh.log'
        $explanation = Get-Content -LiteralPath $foregroundLog -Tail 20 -ErrorAction SilentlyContinue | Out-String
        Stop-ScheduledTask -TaskName $sshTaskName -ErrorAction SilentlyContinue
        Disable-ScheduledTask -TaskName $sshTaskName -ErrorAction SilentlyContinue | Out-Null
        throw "OpenSSH foreground startup failed. $explanation"
    }
}

try {
    $principal = [Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this installer in an elevated 64-bit PowerShell.'
    }
    $publicKey = (Get-Content -Raw -LiteralPath $ControllerKeyFile).Trim()
    if ($publicKey -notmatch '\Assh-ed25519 [A-Za-z0-9+/=]{68}( [!-~ ]{1,128})?\z') {
        throw 'The controller key must be a single OpenSSH Ed25519 key.'
    }
    $sshService = Get-Service sshd
    $hasConfig = Test-Path -LiteralPath $sshConfig
    $ownConfig = $hasConfig -and (Get-Content -LiteralPath $sshConfig -TotalCount 1) -eq '# Managed by AIDevVM installer'
    if ($sshService.Status -ne 'Stopped' -or ($hasConfig -and (!$Resume -or !$ownConfig))) {
        throw 'An existing OpenSSH configuration or running service needs an explicit listener merge.'
    }
    $existing = Get-LocalUser -Name $account -ErrorAction SilentlyContinue
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($Resume) {
        if (!$existing -or !$existingTask -or !(Test-Path -LiteralPath (Join-Path $app 'host.json')) -or
            !(Test-Path -LiteralPath $DataRoot)) { throw 'The partial AIDevVM installation was not found.' }
        $taskXml = [xml] (Export-ScheduledTask -TaskName $taskName)
        $taskIdentity = [string] $taskXml.Task.Principals.Principal.UserId
        if ($taskIdentity -notin @($existing.SID.Value, "$env:COMPUTERNAME\$account", $account)) {
            throw 'The existing task has an unexpected account.'
        }
        Grant-WorkerBatchLogon $existing.SID
    } elseif ($existing -or $existingTask -or (Test-Path -LiteralPath $app) -or (Test-Path -LiteralPath $DataRoot)) {
        throw 'An AIDevVM account, task or directory already exists. Inspect it before installing.'
    }
    foreach ($file in @($Python,$vbox,$winSshd,$winKeygen,
        (Join-Path $Assets 'debian13.vdi'),(Join-Path $Assets 'terraform\terraform.exe'),
        (Join-Path $Assets 'pycdlib-1.16.0-py2.py3-none-any.whl'))) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing dependency $file" }
    }
    if ("$Python$app" -match '\s') { throw 'The Windows SSH entry point requires paths without whitespace.' }
    $wheel = Join-Path $Assets 'pycdlib-1.16.0-py2.py3-none-any.whl'
    if ((Get-FileHash -LiteralPath $wheel).Hash -ne '17843829C6BF2FD365D3D2E49A94F06DA82C999EFC313B9F26B0CE59C0070785') {
        throw 'The pycdlib wheel failed SHA-256 verification.'
    }
    if (!$Resume) {
    $taskPassword = [guid]::NewGuid().ToString('N') + 'Az9!' + [guid]::NewGuid().ToString('N')
    $userArgs = @{
        Name = $account
        Password = ConvertTo-SecureString $taskPassword -AsPlainText -Force
        PasswordNeverExpires = $true
        UserMayNotChangePassword = $true
        Description = 'Terraform and VirtualBox development leases'
    }
    $serviceUser = New-LocalUser @userArgs
    Add-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]'S-1-5-32-545') -Member $serviceUser
    Grant-WorkerBatchLogon $serviceUser.SID
    $sid = $serviceUser.SID.Value
    $localUser = "$env:COMPUTERNAME\$account"
    New-Item -ItemType Directory -Path $app,$DataRoot,$sshDirectory -Force | Out-Null
    Set-DirectoryPermissions $app $sid 'RX'
    Set-DirectoryPermissions $DataRoot $sid 'M'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'host.py'),(Join-Path $PSScriptRoot 'main.tf'),$wheel,
        (Join-Path $Assets 'terraform\terraform.exe') -Destination $app
    Copy-Item -LiteralPath (Join-Path $Assets 'debian13.vdi') -Destination (Join-Path $app 'debian13.vdi')
    @{
        root = $DataRoot
        vbox = $vbox
        terraform = Join-Path $app 'terraform.exe'
        ssh_keygen = $winKeygen
        image = Join-Path $app 'debian13.vdi'
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $app 'host.json') -Encoding ASCII
    'from="192.168.40.200",no-agent-forwarding,no-pty,no-user-rc,no-X11-forwarding {0}' -f $publicKey |
        Set-Content -LiteralPath $keyFile -Encoding ASCII

    $runner = Join-Path $app 'Start-Worker.ps1'
    @'
param([string] $Python, [string] $App, [string] $Data)
$ErrorActionPreference = 'Continue'
$log = Join-Path $Data 'worker.log'
if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt 1MB)) {
    Move-Item -LiteralPath $log -Destination (Join-Path $Data 'worker.previous.log') -Force
}
& $Python -I (Join-Path $App 'host.py') serve 2>> $log
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $runner -Encoding ASCII
    $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Python "{1}" -App "{2}" -Data "{3}"' -f $runner,$Python,$app,$DataRoot
    $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $app
    $settingsArgs = @{
        ExecutionTimeLimit = [timespan]::Zero
        StartWhenAvailable = $true
        AllowStartIfOnBatteries = $true
        DontStopIfGoingOnBatteries = $true
        MultipleInstances = 'IgnoreNew'
        RestartCount = 999
        RestartInterval = New-TimeSpan -Minutes 1
    }
    $taskSettings = New-ScheduledTaskSettingsSet @settingsArgs
    $taskArgs = @{
        TaskName = $taskName
        Action = $taskAction
        Trigger = New-ScheduledTaskTrigger -AtStartup
        Settings = $taskSettings
        User = $localUser
        Password = $taskPassword
        RunLevel = 'Limited'
    }
    Register-ScheduledTask @taskArgs | Out-Null
    Remove-Variable taskPassword,taskArgs,userArgs
    }
    & (Join-Path $PSScriptRoot 'Set-VirtualBoxWorkerAccess.ps1')
    Start-ScheduledTask -TaskName $taskName
    $end = (Get-Date).AddSeconds(15)
    while (!(Test-Path -LiteralPath (Join-Path $DataRoot 'worker.lock')) -and (Get-Date) -lt $end) {
        Start-Sleep -Milliseconds 500
    }
    if (!(Test-Path -LiteralPath (Join-Path $DataRoot 'worker.lock')) -or
        (Get-ScheduledTask -TaskName $taskName).State -ne 'Running') {
        $taskResult = (Get-ScheduledTaskInfo -TaskName $taskName).LastTaskResult
        throw "Worker did not start. Task result $taskResult."
    }

    $provisioningOpenSsh = $true
    New-Item -ItemType Directory -Path $sshLogs -Force | Out-Null
    foreach ($directory in @($sshDirectory,$sshLogs)) {
        Invoke-Checked icacls.exe @($directory, '/setowner', '*S-1-5-32-544')
        Invoke-Checked icacls.exe @($directory, '/inheritance:r', '/grant:r',
            '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-11:(OI)(CI)RX')
    }
    if (!(Test-Path -LiteralPath $hostKey)) {
        $keygen = "import subprocess,sys;sys.exit(subprocess.call([sys.argv[1],'-q','-t','ed25519','-N',str(),'-f',sys.argv[2]]))"
        Invoke-Checked $Python @('-I','-c',$keygen,$winKeygen,$hostKey)
    }
    if (!(Test-Path -LiteralPath "$hostKey.pub") -or !(Test-Path -LiteralPath $keyFile)) {
        throw 'The Windows host public key or controller key authorization file is missing.'
    }
    Invoke-Checked icacls.exe @($hostKey, '/setowner', '*S-1-5-18')
    $privateKeyAcl = Get-Acl -LiteralPath $hostKey
    $privateKeyAcl.SetSecurityDescriptorSddlForm('D:P(A;;FA;;;SY)(A;;FA;;;BA)', [Security.AccessControl.AccessControlSections]::Access)
    Set-Acl -LiteralPath $hostKey -AclObject $privateKeyAcl
    Invoke-Checked icacls.exe @($keyFile, '/setowner', '*S-1-5-32-544')
    $ports = (22400..22407 | ForEach-Object { "127.0.0.1:$_" }) -join ' '
    $keyLocation = $hostKey.Replace('\','/')
    $authLocation = $keyFile.Replace('\','/')
    $cmd = '{0} -I {1} ssh' -f $Python,(Join-Path $app 'host.py')
    @"
# Managed by AIDevVM installer
Port 2224
AddressFamily inet
HostKey "$keyLocation"
AuthorizedKeysFile "$authLocation"
AllowUsers aidevvm@192.168.40.200
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
PermitEmptyPasswords no
AllowAgentForwarding no
AllowTcpForwarding local
PermitOpen $ports
PermitTTY no
SyslogFacility LOCAL0
LogLevel VERBOSE
ForceCommand $cmd
"@ | Set-Content -LiteralPath $sshConfig -Encoding ASCII

    Invoke-Checked $winSshd @('-t','-f',$sshConfig)
    $firewall = @{
        Name = 'AIDevVM-Chasebot-SSH'
        DisplayName = 'AIDevVM SSH from Chasebot'
        Direction = 'Inbound'
        Action = 'Allow'
        Protocol = 'TCP'
        LocalAddress = '192.168.40.136'
        LocalPort = 2224
        RemoteAddress = '192.168.40.200'
    }
    New-NetFirewallRule @firewall | Out-Null
    Set-Service sshd -StartupType Automatic
    try {
        Start-Service sshd
        $listenerMode = 'Windows sshd service'
        $unusedFallback = Get-ScheduledTask -TaskName $sshTaskName -ErrorAction SilentlyContinue
        if ($unusedFallback -and $unusedFallback.State -eq 'Disabled') {
            Unregister-ScheduledTask -TaskName $sshTaskName -Confirm:$false
        }
    } catch {
        Write-Warning 'The Windows service launch failed. Trying the installed OpenSSH binary as a startup task.'
        Set-Service sshd -StartupType Manual
        Start-OpenSshAtBoot
        $listenerMode = 'AIDevVM-OpenSSH startup task'
    }
    @{
        ready = $true
        hostPublicKey = (Get-Content -Raw -LiteralPath "$hostKey.pub").Trim()
        ssh = '192.168.40.136:2224'
        listener = $listenerMode
        dataRoot = $DataRoot
        worker = (Get-ScheduledTask -TaskName $taskName).State.ToString()
    } | ConvertTo-Json | Set-Content -LiteralPath $Result -Encoding ASCII
} catch {
    if ($provisioningOpenSsh) {
        Stop-Service sshd -ErrorAction SilentlyContinue
        Get-NetFirewallRule -Name 'AIDevVM-Chasebot-SSH' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        Set-Service sshd -StartupType Manual -ErrorAction SilentlyContinue
    }
    $sshLog = Join-Path $sshLogs 'sshd.log'
    @{ ready = $false; error = ($_ | Out-String); sshLog = @(Get-Content -LiteralPath $sshLog -Tail 20 -ErrorAction SilentlyContinue) } |
        ConvertTo-Json | Set-Content -LiteralPath $Result -Encoding ASCII
    throw
}
