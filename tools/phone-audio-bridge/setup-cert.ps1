param(
  [Parameter(Mandatory = $true)][string]$IpAddress,
  [Parameter(Mandatory = $true)][string]$OutputDir
)

$ErrorActionPreference = 'Stop'
$subject = 'CN=Buddy Throwaway Audio CA'
$friendlyName = 'Buddy Throwaway Audio CA'
$leafFriendlyName = 'Buddy Throwaway Audio Server'

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# Replace previous throwaway certificates so a DHCP address change cannot
# leave the tool serving a leaf certificate for the wrong address.
Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.FriendlyName -in @($friendlyName, $leafFriendlyName) } |
  Remove-Item -Force

$ca = New-SelfSignedCertificate `
  -Type Custom `
  -Subject $subject `
  -FriendlyName $friendlyName `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -KeyUsage CertSign, CRLSign, DigitalSignature `
  -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0') `
  -NotAfter (Get-Date).AddYears(3)

$san = "2.5.29.17={text}IPAddress=$IpAddress&DNS=clicky-audio.local&DNS=$env:COMPUTERNAME"
$leaf = New-SelfSignedCertificate `
  -Type Custom `
  -Subject 'CN=Buddy Throwaway Audio Server' `
  -FriendlyName $leafFriendlyName `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -Signer $ca `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -TextExtension @($san, '2.5.29.19={critical}{text}ca=0') `
  -NotAfter (Get-Date).AddDays(365)

$passwordText = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
$password = ConvertTo-SecureString -String $passwordText -Force -AsPlainText

Export-PfxCertificate `
  -Cert "Cert:\CurrentUser\My\$($leaf.Thumbprint)" `
  -FilePath (Join-Path $OutputDir 'server.pfx') `
  -Password $password | Out-Null
Export-Certificate `
  -Cert "Cert:\CurrentUser\My\$($ca.Thumbprint)" `
  -FilePath (Join-Path $OutputDir 'clicky-audio-ca.cer') `
  -Type CERT | Out-Null

Set-Content -LiteralPath (Join-Path $OutputDir 'server-pass.txt') -Value $passwordText -NoNewline
@{
  ipAddress = $IpAddress
  caThumbprint = $ca.Thumbprint
  leafThumbprint = $leaf.Thumbprint
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDir 'metadata.json') -Encoding utf8

Write-Output "generated Buddy phone-audio certificates for $IpAddress"
