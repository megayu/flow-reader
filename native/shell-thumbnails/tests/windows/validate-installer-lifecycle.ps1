param(
  [string]$InstallerPath,
  [string]$ProviderPath
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallerPath) -or [string]::IsNullOrWhiteSpace($ProviderPath)) {
  throw 'Usage: validate-installer-lifecycle.ps1 -InstallerPath <setup.exe> -ProviderPath <FlowReaderThumbnail.dll>'
}

$scriptDirectory = Split-Path -Parent $PSCommandPath
$nativeRoot = (Resolve-Path (Join-Path $scriptDirectory '..\..')).Path
$identifiersPath = Join-Path $nativeRoot 'windows-identifiers.json'
$identifiers = Get-Content -LiteralPath $identifiersPath -Raw | ConvertFrom-Json
$providerClsid = [string]$identifiers.providerClsid
$thumbnailHandlerCategoryId = [string]$identifiers.thumbnailHandlerCategoryId
$epubProgId = [string]$identifiers.epubProgId
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$distributionProvider = (Resolve-Path -LiteralPath $ProviderPath).Path
$registeredHost = Join-Path $nativeRoot 'target\x86_64-pc-windows-msvc\release\registered-thumbnail-host.exe'
$installDirectory = Join-Path $env:LOCALAPPDATA 'Flow Reader'
$installedExecutable = Join-Path $installDirectory 'Flow Reader.exe'
$installedProvider = Join-Path $installDirectory 'FlowReaderThumbnail.dll'
$pendingProvider = Join-Path $installDirectory 'FlowReaderThumbnail.pending.dll'
$uninstallKey = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\Flow Reader'
$providerKey = "Registry::HKEY_CURRENT_USER\Software\Classes\CLSID\$providerClsid"
$providerServerKey = "$providerKey\InprocServer32"
$shellHandlerKey = "Registry::HKEY_CURRENT_USER\Software\Classes\$epubProgId\ShellEx\$thumbnailHandlerCategoryId"
$progIdCommandKey = "Registry::HKEY_CURRENT_USER\Software\Classes\$epubProgId\shell\open\command"
$epubClassKey = 'Registry::HKEY_CURRENT_USER\Software\Classes\.epub'
$openWithProgIdsKey = "$epubClassKey\OpenWithProgids"
$registeredApplicationsKey = 'Registry::HKEY_CURRENT_USER\Software\RegisteredApplications'
$capabilitiesKey = 'Registry::HKEY_CURRENT_USER\Software\Flow Reader\Capabilities'
$capabilityAssociationsKey = "$capabilitiesKey\FileAssociations"
$userChoiceKey = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.epub\UserChoice'
$sentinelKey = 'Registry::HKEY_CURRENT_USER\Software\Classes\Applications\FlowReaderThumbnailLifecycleSentinel.exe'
$sentinelSupportedTypes = "$sentinelKey\SupportedTypes"
$installAttempted = $false
$sentinelCreated = $false
$epubClassExisted = Test-Path -LiteralPath $epubClassKey
$epubDefaultExisted = $false
$epubDefault = $null
$userChoiceExisted = Test-Path -LiteralPath $userChoiceKey
$userChoiceValues = @{}
$ownedAssociationValues = @(
  "${epubProgId}_backup",
  'FlowReaderThumbnailOriginalProgId',
  'FlowReaderThumbnailOriginalProgIdPresent',
  'FlowReaderThumbnailOriginalProgIdSaved'
)

if ($epubClassExisted) {
  $epubClass = Get-Item -LiteralPath $epubClassKey
  $epubDefaultExisted = $epubClass.GetValueNames() -contains ''
  if ($epubDefaultExisted) {
    $epubDefault = $epubClass.GetValue('')
  }
}

if ($userChoiceExisted) {
  $userChoice = Get-Item -LiteralPath $userChoiceKey
  foreach ($valueName in $userChoice.GetValueNames()) {
    $userChoiceValues[$valueName] = $userChoice.GetValue($valueName)
  }
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
  }
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
  }
  finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Invoke-Installer {
  param([Parameter(Mandatory = $true)][string]$Path)

  $process = Start-Process -FilePath $Path -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer failed with exit code $($process.ExitCode): $Path"
  }
}

function Assert-InstalledProvider {
  param([Parameter(Mandatory = $true)][string]$ExpectedHash)

  if (-not (Test-Path -LiteralPath $installedProvider -PathType Leaf)) {
    throw "Installed provider DLL is missing: $installedProvider"
  }
  $installedHash = Get-Sha256 -Path $installedProvider
  if ($installedHash -ne $ExpectedHash) {
    throw "Installed provider hash '$installedHash' does not match expected build '$ExpectedHash'."
  }
  if (Test-Path -LiteralPath $pendingProvider) {
    throw "A normal installation left the pending provider behind: $pendingProvider"
  }
  $providerFiles = @(Get-ChildItem -LiteralPath $installDirectory -Filter 'FlowReaderThumbnail*.dll' -File)
  if ($providerFiles.Count -ne 1 -or $providerFiles[0].Name -ne 'FlowReaderThumbnail.dll') {
    throw "The installation directory does not contain exactly one stable provider DLL: $($providerFiles.Name -join ', ')"
  }
  if (Test-Path -LiteralPath (Join-Path $installDirectory 'shell-thumbnails')) {
    throw 'The obsolete shell-thumbnails installation directory still exists.'
  }
  $registeredDll = (Get-Item -LiteralPath $providerServerKey).GetValue('')
  if (-not [string]::Equals($registeredDll, $installedProvider, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Provider registration points to '$registeredDll' instead of '$installedProvider'"
  }
  $threadingModel = (Get-Item -LiteralPath $providerServerKey).GetValue('ThreadingModel')
  if ($threadingModel -ne 'Apartment') {
    throw "Provider ThreadingModel is '$threadingModel' instead of 'Apartment'"
  }
  $registeredClsid = (Get-Item -LiteralPath $shellHandlerKey).GetValue('')
  if ($registeredClsid -ne $providerClsid) {
    throw "EPUB ShellEx registration points to '$registeredClsid' instead of '$providerClsid'"
  }

  $registeredCapability = (Get-Item -LiteralPath $registeredApplicationsKey).GetValue('Flow Reader')
  if ($registeredCapability -ne 'Software\Flow Reader\Capabilities') {
    throw "RegisteredApplications points to '$registeredCapability' instead of the Flow Reader capabilities key."
  }
  $capabilities = Get-Item -LiteralPath $capabilitiesKey
  if ($capabilities.GetValue('ApplicationName') -ne 'Flow Reader') {
    throw 'Flow Reader capabilities do not contain the expected application name.'
  }
  if ($capabilities.GetValue('ApplicationDescription') -ne 'Read EPUB eBooks with Flow Reader.') {
    throw 'Flow Reader capabilities do not contain the required application description.'
  }
  if ($capabilities.GetValue('ApplicationIcon') -ne "$installedExecutable,0") {
    throw 'Flow Reader capabilities do not point to the installed executable icon.'
  }
  if ((Get-Item -LiteralPath $capabilityAssociationsKey).GetValue('.epub') -ne $epubProgId) {
    throw 'Flow Reader capabilities do not map .epub to the canonical ProgID.'
  }
  if ((Get-Item -LiteralPath $openWithProgIdsKey).GetValueNames() -notcontains $epubProgId) {
    throw 'The EPUB OpenWithProgids key does not include FlowReader.Epub.'
  }
  $openCommand = (Get-Item -LiteralPath $progIdCommandKey).GetValue('')
  $expectedCommand = "`"$installedExecutable`" `"%1`""
  if ($openCommand -ne $expectedCommand) {
    throw "The EPUB open command is '$openCommand' instead of '$expectedCommand'."
  }
}

function Assert-UserChoiceUnchanged {
  $currentExists = Test-Path -LiteralPath $userChoiceKey
  if ($currentExists -ne $userChoiceExisted) {
    throw 'The installer changed whether the protected EPUB UserChoice key exists.'
  }
  if (-not $currentExists) {
    return
  }
  $current = Get-Item -LiteralPath $userChoiceKey
  $currentNames = @($current.GetValueNames())
  if ($currentNames.Count -ne $userChoiceValues.Count) {
    throw 'The installer changed the protected EPUB UserChoice value set.'
  }
  foreach ($valueName in $userChoiceValues.Keys) {
    if ($currentNames -notcontains $valueName -or $current.GetValue($valueName) -ne $userChoiceValues[$valueName]) {
      throw "The installer changed the protected EPUB UserChoice value '$valueName'."
    }
  }
}

function New-SyntheticEpub {
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  $path = Join-Path $tempRoot "flow-reader-thumbnail-$([Guid]::NewGuid().ToString('N')).epub"
  $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
      $entries = @{
        'META-INF/container.xml' = '<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>'
        'package.opf' = '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Lifecycle cover</dc:title><dc:creator>Flow Reader</dc:creator></metadata><manifest><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/></manifest></package>'
      }
      foreach ($entryName in $entries.Keys) {
        $entry = $archive.CreateEntry($entryName)
        $writer = New-Object IO.StreamWriter($entry.Open(), (New-Object Text.UTF8Encoding($false)))
        try {
          $writer.Write($entries[$entryName])
        }
        finally {
          $writer.Dispose()
        }
      }
      $coverBytes = [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAaSURBVBhXY9AIqPhfEaDxnyGgQuO/RkXAfwBBlAe9LXzOOgAAAABJRU5ErkJggg==')
      $coverStream = $archive.CreateEntry('cover.png').Open()
      try {
        $coverStream.Write($coverBytes, 0, $coverBytes.Length)
      }
      finally {
        $coverStream.Dispose()
      }
    }
    finally {
      $archive.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
  return $path
}

function Invoke-FreshThumbnailRequest {
  $epubPath = New-SyntheticEpub
  try {
    Invoke-CheckedCommand $registeredHost @($epubPath, '256')
  }
  finally {
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $resolvedEpub = [IO.Path]::GetFullPath($epubPath)
    if (-not $resolvedEpub.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove EPUB outside the temporary directory: $resolvedEpub"
    }
    if (Test-Path -LiteralPath $resolvedEpub -PathType Leaf) {
      Remove-Item -LiteralPath $resolvedEpub -Force
    }
  }
}

function Restore-EpubDefault {
  if (-not (Test-Path -LiteralPath $epubClassKey)) {
    if ($epubClassExisted) {
      New-Item -Path $epubClassKey -Force | Out-Null
    }
    else {
      return
    }
  }
  $epubClass = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Classes\.epub', $true)
  if ($null -eq $epubClass) {
    throw 'Could not open the EPUB association key for recovery.'
  }
  try {
    if ($epubDefaultExisted) {
      $epubClass.SetValue('', $epubDefault, [Microsoft.Win32.RegistryValueKind]::String)
    }
    else {
      $epubClass.DeleteValue('', $false)
    }
  }
  finally {
    $epubClass.Dispose()
  }
}

function Remove-SentinelRegistration {
  if (-not (Test-Path -LiteralPath $sentinelKey)) {
    return
  }
  $children = @(Get-ChildItem -LiteralPath $sentinelKey)
  if ($children.Count -ne 1 -or $children[0].PSChildName -ne 'SupportedTypes') {
    throw "Refusing to remove an unexpected sentinel registry tree: $sentinelKey"
  }
  $supportedTypes = Get-Item -LiteralPath $sentinelSupportedTypes
  $valueNames = @($supportedTypes.GetValueNames())
  if ($valueNames.Count -ne 1 -or $valueNames[0] -ne '.epub') {
    throw "Refusing to remove unexpected sentinel registry values: $sentinelSupportedTypes"
  }
  Remove-ItemProperty -LiteralPath $sentinelSupportedTypes -Name '.epub'
  Remove-Item -LiteralPath $sentinelSupportedTypes
  Remove-Item -LiteralPath $sentinelKey
}

try {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem

  foreach ($requiredFile in @($installer, $distributionProvider, $registeredHost)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
      throw "Lifecycle validation input is missing: $requiredFile"
    }
  }

  foreach ($path in @($uninstallKey, $providerKey, $shellHandlerKey, $capabilitiesKey, $sentinelKey, $installDirectory)) {
    if (Test-Path -LiteralPath $path) {
      throw "Lifecycle validation requires an unused Flow Reader installation state: $path"
    }
  }
  if ($epubClassExisted) {
    $existingAssociationValues = (Get-Item -LiteralPath $epubClassKey).GetValueNames()
    foreach ($valueName in $ownedAssociationValues) {
      if ($existingAssociationValues -contains $valueName) {
        throw "Lifecycle validation found pre-existing Flow Reader association state: $valueName"
      }
    }
  }
  if (Test-Path -LiteralPath $registeredApplicationsKey) {
    $registeredApplicationNames = (Get-Item -LiteralPath $registeredApplicationsKey).GetValueNames()
    if ($registeredApplicationNames -contains 'Flow Reader') {
      throw 'Lifecycle validation found a pre-existing Flow Reader RegisteredApplications value.'
    }
  }

  $expectedProviderHash = Get-Sha256 -Path $distributionProvider

  New-Item -Path $sentinelSupportedTypes -Force | Out-Null
  New-ItemProperty -LiteralPath $sentinelSupportedTypes -Name '.epub' -Value '' -PropertyType String -Force | Out-Null
  $sentinelCreated = $true

  $installAttempted = $true
  Invoke-Installer $installer
  Assert-InstalledProvider -ExpectedHash $expectedProviderHash
  Assert-UserChoiceUnchanged
  Invoke-FreshThumbnailRequest

  $uninstaller = Join-Path $installDirectory 'uninstall.exe'
  Invoke-Installer $uninstaller

  foreach ($path in @($uninstallKey, $providerKey, $shellHandlerKey, $capabilitiesKey, $installedProvider, $pendingProvider)) {
    if (Test-Path -LiteralPath $path) {
      throw "Uninstall left Flow Reader-owned state behind: $path"
    }
  }
  if (-not (Test-Path -LiteralPath $sentinelSupportedTypes)) {
    throw 'Uninstall removed another EPUB Open With registration.'
  }
  if ((Get-Item -LiteralPath $registeredApplicationsKey).GetValueNames() -contains 'Flow Reader') {
    throw 'Uninstall left the Flow Reader RegisteredApplications value behind.'
  }
  if ((Test-Path -LiteralPath $openWithProgIdsKey) -and
      (Get-Item -LiteralPath $openWithProgIdsKey).GetValueNames() -contains $epubProgId) {
    throw 'Uninstall left FlowReader.Epub in OpenWithProgids.'
  }
  Assert-UserChoiceUnchanged
  $currentEpubClass = if (Test-Path -LiteralPath $epubClassKey) {
    Get-Item -LiteralPath $epubClassKey
  }
  $currentDefaultExisted = $null -ne $currentEpubClass -and $currentEpubClass.GetValueNames() -contains ''
  $currentDefault = if ($currentDefaultExisted) { $currentEpubClass.GetValue('') } else { $null }
  if ($currentDefaultExisted -ne $epubDefaultExisted) {
    throw 'Uninstall did not restore whether the EPUB default ProgID existed.'
  }
  if ($epubDefaultExisted -and $currentDefault -ne $epubDefault) {
    throw "Uninstall restored EPUB ProgID '$currentDefault' instead of '$epubDefault'"
  }
  $remainingAssociationValues = if ($null -ne $currentEpubClass) {
    $currentEpubClass.GetValueNames()
  }
  else {
    @()
  }
  foreach ($valueName in $ownedAssociationValues) {
    if ($remainingAssociationValues -contains $valueName) {
      throw "Uninstall left Flow Reader association state behind: $valueName"
    }
  }

  Write-Output 'Windows release installer lifecycle passed.'
}
finally {
  if ($installAttempted -and (Test-Path -LiteralPath (Join-Path $installDirectory 'uninstall.exe') -PathType Leaf)) {
    $cleanup = Start-Process -FilePath (Join-Path $installDirectory 'uninstall.exe') -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    if ($cleanup.ExitCode -ne 0) {
      Write-Warning "Cleanup uninstaller exited with code $($cleanup.ExitCode)."
    }
  }
  Restore-EpubDefault
  if ($sentinelCreated) {
    Remove-SentinelRegistration
  }
}
