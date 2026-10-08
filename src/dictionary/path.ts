const WINDOWS_EXTENDED_PREFIX = '\\\\?\\'
const WINDOWS_UNC_PREFIX = 'UNC\\'

function stripWindowsExtendedPrefix(path: string) {
  if (!path.startsWith(WINDOWS_EXTENDED_PREFIX)) return path

  const nativePath = path.slice(WINDOWS_EXTENDED_PREFIX.length)
  if (nativePath.toUpperCase().startsWith(WINDOWS_UNC_PREFIX)) {
    return `\\\\${nativePath.slice(WINDOWS_UNC_PREFIX.length)}`
  }
  return /^[A-Za-z]:\\/.test(nativePath) ? nativePath : path
}

export function formatLocalPathForDisplay(path: string) {
  const nativePath = stripWindowsExtendedPrefix(path)
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(nativePath) || /^[\\/]{2}[^\\/]/.test(nativePath)
  return isWindowsPath ? nativePath.replaceAll('/', '\\') : nativePath
}

export function formatLocalDirectoryForDisplay(path: string) {
  const displayPath = formatLocalPathForDisplay(path)
  const separatorIndex = Math.max(displayPath.lastIndexOf('/'), displayPath.lastIndexOf('\\'))

  if (separatorIndex < 0) return ''
  if (separatorIndex === 0) return displayPath[0]

  const directory = displayPath.slice(0, separatorIndex)
  return /^[A-Za-z]:$/.test(directory) ? `${directory}\\` : directory
}
