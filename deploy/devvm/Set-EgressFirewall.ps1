# Restrict what the development VMs can reach: ONLY the Chasebot egress proxy (TCP <ProxyPort> on <ControllerAddress>).
# VirtualBox NAT traffic leaves Windows from the VM process (VBoxHeadless.exe / VirtualBoxVM.exe), so outbound
# Block rules on those programs close the "guests may reach LAN destinations through NAT" gap: the LAN, the router,
# this PC's own addresses, Chasebot's other services, Pantry Bot and the internet are all refused. Windows applies
# Block rules over Allow rules, and the one permitted path is simply left unblocked.
#
# Run in an elevated PowerShell on the gaming PC:
#   .\Set-EgressFirewall.ps1 -ControllerAddress <chasebot-ip> [-ProxyPort 3128]
#   .\Set-EgressFirewall.ps1 -Remove
# Note: the rules apply to every VM started with these VirtualBox binaries on this PC, including personal ones.
# Then prove each refusal from Chasebot with deploy/devvm/egress_acceptance.py.
[CmdletBinding()]
param(
    [ValidatePattern('^\d{1,3}(\.\d{1,3}){3}$')] [string] $ControllerAddress,
    [ValidateRange(1, 65535)] [int] $ProxyPort = 3128,
    [string] $VirtualBox = 'C:\Program Files\Oracle\VirtualBox',
    [switch] $Remove
)
$ErrorActionPreference = 'Stop'
$group = 'AIDevVM egress'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script in an elevated PowerShell.' }
Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) { Write-Output 'AIDevVM egress rules removed.'; return }
if (!$ControllerAddress) { throw 'Provide -ControllerAddress (Chasebot''s LAN address).' }

function ConvertTo-Number([string] $Address) {
    $b = ([Net.IPAddress]::Parse($Address)).GetAddressBytes(); [uint32](($b[0] -shl 24) -bor ($b[1] -shl 16) -bor ($b[2] -shl 8) -bor $b[3])
}
function ConvertTo-Address([uint32] $Number) {
    '{0}.{1}.{2}.{3}' -f (($Number -shr 24) -band 255), (($Number -shr 16) -band 255), (($Number -shr 8) -band 255), ($Number -band 255)
}
# All IPv4 space except loopback (127/8, needed for the host's SSH port forward) and the controller itself.
$controller = ConvertTo-Number $ControllerAddress
$holes = @(@((ConvertTo-Number '127.0.0.0'), (ConvertTo-Number '127.255.255.255')), @($controller, $controller)) | Sort-Object { $_[0] }
$ranges = @(); [uint64] $start = 0
foreach ($h in $holes) {
    if ($h[0] -gt $start) { $ranges += '{0}-{1}' -f (ConvertTo-Address ([uint32]$start)), (ConvertTo-Address ([uint32]($h[0] - 1))) }
    $start = [uint64]$h[1] + 1
}
if ($start -le 4294967295) { $ranges += '{0}-255.255.255.255' -f (ConvertTo-Address ([uint32]$start)) }
$ports = @(); if ($ProxyPort -gt 1) { $ports += "1-$($ProxyPort - 1)" }; if ($ProxyPort -lt 65535) { $ports += "$($ProxyPort + 1)-65535" }

$programs = @('VBoxHeadless.exe', 'VirtualBoxVM.exe') | ForEach-Object { Join-Path $VirtualBox $_ } | Where-Object { Test-Path -LiteralPath $_ }
if (!$programs) { throw "No VirtualBox VM binaries found under $VirtualBox" }
foreach ($program in $programs) {
    $name = [IO.Path]::GetFileNameWithoutExtension($program)
    $common = @{ Group = $group; Direction = 'Outbound'; Action = 'Block'; Program = $program; Profile = 'Any' }
    New-NetFirewallRule @common -Name "AIDevVM-$name-v4" -DisplayName "AIDevVM: $name to anything but the proxy host" -RemoteAddress $ranges | Out-Null
    New-NetFirewallRule @common -Name "AIDevVM-$name-v6" -DisplayName "AIDevVM: $name IPv6" -RemoteAddress '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff' | Out-Null
    New-NetFirewallRule @common -Name "AIDevVM-$name-ctl-tcp" -DisplayName "AIDevVM: $name to Chasebot ports other than the proxy" -RemoteAddress $ControllerAddress -Protocol TCP -RemotePort $ports | Out-Null
    New-NetFirewallRule @common -Name "AIDevVM-$name-ctl-udp" -DisplayName "AIDevVM: $name UDP to Chasebot" -RemoteAddress $ControllerAddress -Protocol UDP | Out-Null
    New-NetFirewallRule @common -Name "AIDevVM-$name-ctl-icmp" -DisplayName "AIDevVM: $name ICMP to Chasebot" -RemoteAddress $ControllerAddress -Protocol ICMPv4 | Out-Null
}
Get-NetFirewallRule -Group $group | Select-Object Name, Enabled, Action | Format-Table -AutoSize
Write-Output "Guests may now reach only ${ControllerAddress}:$ProxyPort. Prove it with egress_acceptance.py from Chasebot."
