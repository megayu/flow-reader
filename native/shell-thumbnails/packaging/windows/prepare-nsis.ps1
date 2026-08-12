param(
  [string]$DllPath
)

$ErrorActionPreference = 'Stop'

$scriptDirectory = Split-Path -Parent $PSCommandPath
$nativeRoot = (Resolve-Path (Join-Path $scriptDirectory '..\..')).Path
$outputRoot = Join-Path $nativeRoot 'dist\windows'
$installerRoot = Join-Path $outputRoot 'installer'
$identifiersPath = Join-Path $nativeRoot 'windows-identifiers.json'
$hookTemplate = Join-Path $scriptDirectory 'installer-hooks.nsh.in'
$hookOutput = Join-Path $outputRoot 'installer-hooks.nsh'
$configOutput = Join-Path $outputRoot 'tauri.shell-windows.generated.conf.json'

if ([string]::IsNullOrWhiteSpace($DllPath)) {
  $DllPath = Join-Path $outputRoot 'FlowReaderThumbnail.dll'
}
if (-not (Test-Path -LiteralPath $DllPath -PathType Leaf)) {
  throw "Windows thumbnail DLL does not exist: $DllPath"
}
$resolvedDll = (Resolve-Path -LiteralPath $DllPath).Path

if (-not (Test-Path -LiteralPath $identifiersPath -PathType Leaf)) {
  throw "Windows identifier manifest does not exist: $identifiersPath"
}
$identifiers = Get-Content -LiteralPath $identifiersPath -Raw | ConvertFrom-Json
$providerClsid = [string]$identifiers.providerClsid
$thumbnailHandlerCategoryId = [string]$identifiers.thumbnailHandlerCategoryId
$epubProgId = [string]$identifiers.epubProgId
$parsedGuid = [Guid]::Empty
foreach ($entry in @(
  @{ Name = 'providerClsid'; Value = $providerClsid },
  @{ Name = 'thumbnailHandlerCategoryId'; Value = $thumbnailHandlerCategoryId }
)) {
  if (-not [Guid]::TryParseExact($entry.Value, 'B', [ref]$parsedGuid)) {
    throw "$($entry.Name) must be a braced GUID."
  }
}
if ($thumbnailHandlerCategoryId -ne '{E357FCCD-A995-4576-B01F-234630154E96}') {
  throw 'thumbnailHandlerCategoryId must remain the Microsoft thumbnail handler category GUID.'
}
if ($epubProgId.Length -gt 39 -or $epubProgId -notmatch '^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)*$') {
  throw 'epubProgId must contain alphanumeric components separated by periods, with no spaces.'
}

$dllName = 'FlowReaderThumbnail.pending.dll'

New-Item -ItemType Directory -Path $installerRoot -Force | Out-Null
$packagedDll = Join-Path $installerRoot $dllName
Copy-Item -LiteralPath $resolvedDll -Destination $packagedDll -Force

$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
$hook = [System.IO.File]::ReadAllText($hookTemplate)
$replacements = @{
  '@PROVIDER_CLSID@' = $providerClsid
  '@THUMBNAIL_HANDLER_CATEGORY_ID@' = $thumbnailHandlerCategoryId
  '@PENDING_THUMBNAIL_DLL@' = $dllName
  '@EPUB_PROGID@' = $epubProgId
  '@EPUB_BACKUP@' = "${epubProgId}_backup"
}
foreach ($replacement in $replacements.GetEnumerator()) {
  $hook = $hook.Replace($replacement.Key, $replacement.Value)
}
if ($hook -match '@[A-Z_]+@') {
  throw 'Generated NSIS hook still contains an unresolved placeholder.'
}
[System.IO.File]::WriteAllText($hookOutput, $hook, $utf8WithoutBom)

$resourceSource = "../native/shell-thumbnails/dist/windows/installer/$dllName"
$generatedConfig = @{
  bundle = @{
    resources = @{
      $resourceSource = $dllName
    }
    windows = @{
      nsis = @{
        installerHooks = '../native/shell-thumbnails/dist/windows/installer-hooks.nsh'
      }
    }
  }
}
$configJson = $generatedConfig | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($configOutput, "$configJson`n", $utf8WithoutBom)

Write-Output "DLL=$packagedDll"
Write-Output "HOOKS=$hookOutput"
Write-Output "CONFIG=$configOutput"
