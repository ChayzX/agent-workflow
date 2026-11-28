[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$account = Get-LocalUser -Name aidevvm
$defaultKey = Get-Item -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Ole'
$defaultLaunch = $defaultKey.GetValue('DefaultLaunchPermission')
$apps = @{
    '{61FF179A-5F10-4077-81F4-060BEBA09DEC}' = 'VirtualBox Application'
    '{EC0E78E8-FA43-43E8-AC0A-02C784C4A4FA}' = 'VirtualBox System Service Application'
}
foreach ($appId in $apps.Keys) {
    $relativeKey = "SOFTWARE\Classes\AppID\$appId"
    $key = Get-Item -LiteralPath "HKLM:\$relativeKey"
    $registeredName = ([string]$key.GetValue('')).Trim([char[]]@(0,9,10,13,32))
    if ($registeredName -ne $apps[$appId]) { throw "Unexpected COM registration for $appId" }
    $value = $key.GetValue('LaunchPermission', $defaultLaunch)
    if ($null -eq $value) {
        $acl = [Security.AccessControl.RawSecurityDescriptor]::new(
            'O:BAG:BAD:(A;;0x1f;;;BA)(A;;0x1f;;;IU)(A;;0x1f;;;SY)')
    } else {
        $acl = [Security.AccessControl.RawSecurityDescriptor]::new([byte[]]$value, 0)
    }
    $alreadyGranted = $acl.DiscretionaryAcl | Where-Object {
        $_.SecurityIdentifier -eq $account.SID -and $_.AceQualifier -eq 'AccessAllowed' -and ($_.AccessMask -band 11) -eq 11
    }
    if (!$alreadyGranted) {
        # COM_RIGHTS_EXECUTE | EXECUTE_LOCAL | ACTIVATE_LOCAL.
        $ace = [Security.AccessControl.CommonAce]::new('None','AccessAllowed',11,$account.SID,$false,$null)
        $acl.DiscretionaryAcl.InsertAce($acl.DiscretionaryAcl.Count, $ace)
        $bytes = [byte[]]::new($acl.BinaryLength)
        $acl.GetBinaryForm($bytes, 0)
        $writable = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($relativeKey, $true)
        try {
            $writable.SetValue('LaunchPermission', $bytes, [Microsoft.Win32.RegistryValueKind]::Binary)
        } finally {
            $writable.Dispose()
        }
    }
    Write-Output "Local launch and activation verified for $($apps[$appId])"
}
