#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS bundle lifecycle validation requires macOS." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/../.." && pwd)"
source_app="${1:-${repo_dir}/src-tauri/target/universal-apple-darwin/release/bundle/macos/Flow Reader.app}"
extension_id="com.flow.reader.thumbnail"
temp_base="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
temp_base="${temp_base%/}"
temp_root="$(mktemp -d "${temp_base}/flow-reader-macos-lifecycle.XXXXXX")"
test_app="${temp_root}/Applications/Flow Reader.app"
thumbnail_dir="${temp_root}/thumbnails"
epub_root="${temp_root}/epub"
epub_path="${temp_root}/fresh-$RANDOM-$RANDOM.epub"
second_epub_path="${temp_root}/second-$RANDOM-$RANDOM.epub"
app_data="${temp_root}/app-data"
registered=0
app_pid=""
remove_temp=1

process_is_running() {
  local process_state=""
  /bin/kill -0 "$1" >/dev/null 2>&1 || return 1
  process_state="$(/bin/ps -p "$1" -o stat= 2>/dev/null || true)"
  [[ -n "${process_state}" && "${process_state:0:1}" != "Z" ]]
}

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )); then
    echo "Preserving failed macOS lifecycle diagnostics at ${temp_root}." >&2
    remove_temp=0
  fi
  if [[ -n "${app_pid}" ]] && process_is_running "${app_pid}"; then
    app_command="$(/bin/ps -p "${app_pid}" -o command= || true)"
    if [[ "${app_command}" == *"${app_executable}"* ]]; then
      /bin/kill "${app_pid}" >/dev/null 2>&1 || true
      for _ in {1..50}; do
        if ! process_is_running "${app_pid}"; then
          break
        fi
        /bin/sleep 0.1
      done
      if process_is_running "${app_pid}"; then
        echo "Flow Reader did not exit; preserving temporary files at ${temp_root}." >&2
        remove_temp=0
      fi
    else
      echo "Refusing to terminate unexpected process ${app_pid}: ${app_command}" >&2
      remove_temp=0
    fi
  fi
  if [[ "${registered}" == "1" ]]; then
    /usr/bin/pluginkit -r "${appex}" >/dev/null 2>&1 || true
  fi
  if [[ "${remove_temp}" == "1" ]]; then
    case "${temp_root}" in
      "${temp_base}"/flow-reader-macos-lifecycle.*)
        rm -rf -- "${temp_root}"
        ;;
      *)
        echo "Refusing to remove unexpected temporary directory: ${temp_root}" >&2
        ;;
    esac
  fi
}
trap cleanup EXIT

if [[ ! -d "${source_app}" ]]; then
  echo "Flow Reader app bundle does not exist: ${source_app}" >&2
  exit 1
fi

/bin/mkdir -p "${temp_root}/Applications" "${thumbnail_dir}" "${epub_root}/META-INF" "${epub_root}/EPUB"
/usr/bin/ditto "${source_app}" "${test_app}"

appex="${test_app}/Contents/PlugIns/FlowReaderThumbnail.appex"
app_executable="${test_app}/Contents/MacOS/Flow Reader"
appex_executable="${appex}/Contents/MacOS/FlowReaderThumbnail"
appex_info="${appex}/Contents/Info.plist"
app_info="${test_app}/Contents/Info.plist"

for required_path in "${appex}" "${app_executable}" "${appex_executable}" "${appex_info}" "${app_info}"; do
  if [[ ! -e "${required_path}" ]]; then
    echo "Required bundled extension path is missing: ${required_path}" >&2
    exit 1
  fi
done

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$1" "${appex_info}"
}

app_plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$1" "${app_info}"
}

[[ "$(plist_value CFBundleIdentifier)" == "${extension_id}" ]]
[[ "$(plist_value NSExtension:NSExtensionPointIdentifier)" == "com.apple.quicklook.thumbnail" ]]
[[ "$(plist_value NSExtension:NSExtensionAttributes:QLSupportedContentTypes:0)" == "org.idpf.epub-container" ]]
[[ "$(app_plist_value CFBundleDocumentTypes:0:CFBundleTypeName)" == "EPUB Book" ]]
[[ "$(app_plist_value CFBundleDocumentTypes:0:CFBundleTypeRole)" == "Viewer" ]]
[[ "$(app_plist_value CFBundleDocumentTypes:0:LSHandlerRank)" == "Default" ]]
[[ "$(app_plist_value CFBundleDocumentTypes:0:CFBundleTypeExtensions:0)" == "epub" ]]
app_content_types="$(app_plist_value CFBundleDocumentTypes:0:LSItemContentTypes)"
if ! printf '%s\n' "${app_content_types}" | /usr/bin/grep -Fq 'org.idpf.epub-container'; then
  echo "Flow Reader app does not declare the standard EPUB content type." >&2
  exit 1
fi

/usr/bin/lipo "${app_executable}" -verify_arch arm64 x86_64
/usr/bin/lipo "${appex_executable}" -verify_arch arm64 x86_64

/usr/bin/codesign --verify --strict --verbose=2 "${appex}"
/usr/bin/codesign --verify --deep --strict --verbose=2 "${test_app}"

create_epub() {
  local output_path="$1"
  local title="$2"
  printf '%s' 'application/epub+zip' > "${epub_root}/mimetype"
  printf '%s' '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' > "${epub_root}/META-INF/container.xml"
  printf '%s' "<?xml version=\"1.0\" encoding=\"UTF-8\"?><package version=\"3.0\" unique-identifier=\"book-id\" xmlns=\"http://www.idpf.org/2007/opf\"><metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:identifier id=\"book-id\">flow-reader-macos-test</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language></metadata><manifest><item id=\"cover\" href=\"cover.png\" media-type=\"image/png\" properties=\"cover-image\"/><item id=\"chapter\" href=\"chapter.xhtml\" media-type=\"application/xhtml+xml\"/></manifest><spine><itemref idref=\"chapter\"/></spine></package>" > "${epub_root}/EPUB/package.opf"
  printf '%s' "<?xml version=\"1.0\" encoding=\"UTF-8\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>${title}</title></head><body><p>Flow Reader macOS lifecycle test.</p></body></html>" > "${epub_root}/EPUB/chapter.xhtml"
  printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAaSURBVBhXY9AIqPhfEaDxnyGgQuO/RkXAfwBBlAe9LXzOOgAAAABJRU5ErkJggg==' | /usr/bin/base64 -D > "${epub_root}/EPUB/cover.png"
  (
    cd "${epub_root}"
    /usr/bin/zip -q -X -0 "${output_path}" mimetype
    /usr/bin/zip -q -X "${output_path}" META-INF/container.xml EPUB/package.opf EPUB/chapter.xhtml EPUB/cover.png
  )
}

create_epub "${epub_path}" "Quick Look lifecycle"
create_epub "${second_epub_path}" "Finder reopen lifecycle"

/usr/bin/pluginkit -a "${appex}"
registered=1
/usr/bin/pluginkit -e use -i "${extension_id}"
plugin_matches="$(/usr/bin/pluginkit -m -A -D -i "${extension_id}" || true)"
if [[ "${plugin_matches}" != *"${extension_id}"* ]]; then
  echo "Quick Look extension was not registered: ${extension_id}" >&2
  /usr/bin/pluginkit -m -A -D -v -i "${extension_id}" >&2 || true
  exit 1
fi

thumbnail_path="${thumbnail_dir}/quick-look.png"
/usr/bin/xcrun swift - "${epub_path}" "${thumbnail_path}" <<'SWIFT'
import CoreGraphics
import Foundation
import QuickLookThumbnailing
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 3 else {
    fatalError("expected EPUB and thumbnail paths")
}

let request = QLThumbnailGenerator.Request(
    fileAt: URL(fileURLWithPath: CommandLine.arguments[1]),
    size: CGSize(width: 256, height: 256),
    scale: 1,
    representationTypes: .thumbnail
)
request.contentType = UTType(importedAs: "org.idpf.epub-container")
try await QLThumbnailGenerator.shared.saveBestRepresentation(
    for: request,
    to: URL(fileURLWithPath: CommandLine.arguments[2]),
    as: .png
)
SWIFT

/usr/bin/swift - "${thumbnail_path}" <<'SWIFT'
import CoreGraphics
import Foundation
import ImageIO

guard CommandLine.arguments.count == 2 else {
    fatalError("expected a thumbnail path")
}
let url = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
guard let source = CGImageSourceCreateWithURL(url, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fatalError("could not decode Quick Look thumbnail")
}
guard image.width > 1, image.height > 1, image.width <= 256, image.height <= 256 else {
    fatalError("unexpected Quick Look thumbnail dimensions: \(image.width)x\(image.height)")
}
var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
let nonUniform = pixels.withUnsafeMutableBytes { bytes -> Bool in
    guard let context = CGContext(
        data: bytes.baseAddress,
        width: image.width,
        height: image.height,
        bitsPerComponent: 8,
        bytesPerRow: image.width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        return false
    }
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    let pixelBytes = bytes.bindMemory(to: UInt8.self)
    let firstPixel = Array(pixelBytes[0..<4])
    return stride(from: 4, to: pixelBytes.count, by: 4).contains {
        Array(pixelBytes[$0..<($0 + 4)]) != firstPixel
    }
}
guard nonUniform else {
    fatalError("Quick Look returned a uniform placeholder")
}
print("Quick Look rendered \(image.width)x\(image.height) non-uniform RGBA pixels")
SWIFT

library_file="${app_data}/library.json"
library_contains_file() {
  local expected_path="$1"
  [[ -f "${library_file}" ]] || return 1
  node - "${library_file}" "${expected_path}" <<'NODE'
const fs = require('node:fs')

const [libraryPath, expectedPath] = process.argv.slice(2)
try {
  const expectedRealPath = fs.realpathSync.native(expectedPath)
  const library = JSON.parse(fs.readFileSync(libraryPath, 'utf8'))
  const containsExpectedFile = Array.isArray(library.books) && library.books.some((book) => {
    if (typeof book?.sourcePath !== 'string') return false
    try {
      return fs.realpathSync.native(book.sourcePath) === expectedRealPath
    } catch {
      return false
    }
  })
  process.exit(containsExpectedFile ? 0 : 1)
} catch {
  process.exit(1)
}
NODE
}

wait_for_external_path() {
  local expected_path="$1"
  local attempts=0
  while (( attempts < 60 )); do
    if library_contains_file "${expected_path}"; then
      return 0
    fi
    if [[ -n "${app_pid}" ]] && ! process_is_running "${app_pid}"; then
      echo "Flow Reader exited before recording the Finder-opened EPUB: ${expected_path}" >&2
      return 1
    fi
    /bin/sleep 0.5
    attempts=$((attempts + 1))
  done
  echo "Flow Reader did not record the Finder-opened EPUB: ${expected_path}" >&2
  return 1
}

/bin/mkdir -p "${app_data}"
/usr/bin/open -n -a "${test_app}" --env "FLOW_READER_DATA_DIR=${app_data}" "${epub_path}"
find_app_pid() {
  local candidate=""
  local command=""
  while IFS= read -r candidate; do
    [[ -n "${candidate}" ]] || continue
    command="$(/bin/ps -p "${candidate}" -o command= || true)"
    if [[ "${command}" == "${app_executable}"* ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done < <(/usr/bin/pgrep -f "${app_executable}" || true)
  return 1
}
for _ in {1..60}; do
  app_pid="$(find_app_pid || true)"
  if [[ -n "${app_pid}" ]]; then
    break
  fi
  /bin/sleep 0.5
done
if [[ -z "${app_pid}" ]]; then
  echo "Flow Reader did not launch through Launch Services." >&2
  exit 1
fi
wait_for_external_path "${epub_path}"

/usr/bin/open -a "${test_app}" "${second_epub_path}"
wait_for_external_path "${second_epub_path}"

echo "macOS app open and thumbnail extension lifecycle passed."
