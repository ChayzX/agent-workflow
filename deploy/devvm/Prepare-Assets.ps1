[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Destination,
    [string] $Python = 'C:\Python313\python.exe'
)

$ErrorActionPreference = 'Stop'
$Destination = [IO.Path]::GetFullPath($Destination)
New-Item -Path $Destination -ItemType Directory -Force | Out-Null

function Receive-VerifiedFile {
    param([string] $Url, [string] $Name, [string] $Digest, [string] $Algorithm)
    $path = Join-Path $Destination $Name
    if (!(Test-Path -LiteralPath $path)) {
        & curl.exe -fsSL --retry 2 -o "$path.part" $Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed for $Name" }
        if ((Get-FileHash -LiteralPath "$path.part" -Algorithm $Algorithm).Hash -ne $Digest) {
            throw "Checksum mismatch for $Name"
        }
        Move-Item -LiteralPath "$path.part" -Destination $path
    }
    if ((Get-FileHash -LiteralPath $path -Algorithm $Algorithm).Hash -ne $Digest) {
        throw "Checksum mismatch for $Name"
    }
    $path
}

$terraformUrl = 'https://releases.hashicorp.com/terraform/1.15.5/terraform_1.15.5_windows_amd64.zip'
$terraformZip = Receive-VerifiedFile $terraformUrl 'terraform.zip' '2f652dd854af7b7fbb51301afc55b5ef1d3f6e287be7889d4cc3818df891cd38' SHA256
Expand-Archive -LiteralPath $terraformZip -DestinationPath (Join-Path $Destination 'terraform') -Force
$debianUrl = 'https://cloud.debian.org/images/cloud/trixie/20261123-2671/debian-13-generic-amd64-20261123-2671.tar.xz'
$imageHash = '83eb34de89959079b46f034b381bb62abcf1b4383ae7e70a196cf2de02a2e2f65578c1c9a8fdd4965df7c22f006527b44e8b0b246f2ce889143a082a2fcbcb06'
$debianArchive = Receive-VerifiedFile $debianUrl 'debian-13-generic-amd64.tar.xz' $imageHash SHA512
$wheel = Join-Path $Destination 'pycdlib-1.16.0-py2.py3-none-any.whl'
if (!(Test-Path -LiteralPath $wheel)) {
    & $Python -m pip download --no-deps --only-binary=:all: pycdlib==1.16.0 -d $Destination
    if ($LASTEXITCODE -ne 0) { throw 'Could not download pycdlib.' }
}
if ((Get-FileHash -LiteralPath $wheel).Hash -ne '17843829C6BF2FD365D3D2E49A94F06DA82C999EFC313B9F26B0CE59C0070785') {
    throw 'The pycdlib wheel failed SHA-256 verification.'
}
$vdi = Join-Path $Destination 'debian13.vdi'
if (!(Test-Path -LiteralPath $vdi)) {
    & tar.exe -xf $debianArchive -C $Destination disk.raw
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the verified raw disk.' }
    $partial = Join-Path $Destination 'debian13.part.vdi'
    & 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe' convertfromraw (Join-Path $Destination 'disk.raw') $partial --format VDI
    if ($LASTEXITCODE -ne 0) { throw 'VirtualBox failed to convert the base image.' }
    Move-Item -LiteralPath $partial -Destination $vdi
}
Get-Item -LiteralPath $vdi | Select-Object FullName,Length
