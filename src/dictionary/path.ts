const WINDOWS_EXTENDED_PREFIX = '\\\\?\\'
const WINDOWS_UNC_PREFIX = 'UNC\\'

export function formatLocalPathForDisplay(path: string) {
  if (!path.startsWith(WINDOWS_EXTENDED_PREFIX)) return path

  const nativePath = path.slice(WINDOWS_EXTENDED_PREFIX.length)
  if (nativePath.toUpperCase().startsWith(WINDOWS_UNC_PREFIX)) {
    return `\\\\${nativePath.slice(WINDOWS_UNC_PREFIX.length)}`
  }
  return /^[A-Za-z]:\\/.test(nativePath) ? nativePath : path
}
