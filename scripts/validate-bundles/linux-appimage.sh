#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/../.." && pwd)"
appimage_path="${1:-}"
expected_arch="${2:-x86_64}"
if [[ -z "${appimage_path}" ]]; then
  appimage_path="$(find "${repo_dir}/release" -maxdepth 1 -type f -name '*.AppImage' -print -quit 2>/dev/null || true)"
fi
if [[ -z "${appimage_path}" || ! -f "${appimage_path}" ]]; then
  echo "Flow Reader AppImage does not exist: ${appimage_path:-<unspecified>}" >&2
  exit 1
fi
appimage_path="$(realpath "${appimage_path}")"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Linux AppImage validation requires Linux." >&2
  exit 1
fi
if [[ ! -x "${appimage_path}" ]]; then
  echo "Flow Reader AppImage is not executable: ${appimage_path}" >&2
  exit 1
fi
case "${expected_arch}" in
  x86_64)
    architecture_pattern='ELF 64-bit.*x86-64'
    ;;
  aarch64)
    architecture_pattern='ELF 64-bit.*ARM aarch64'
    ;;
  *)
    echo "Unsupported AppImage architecture: ${expected_arch}" >&2
    exit 1
    ;;
esac
if ! file "${appimage_path}" | grep -Eq "${architecture_pattern}"; then
  echo "Flow Reader AppImage does not target ${expected_arch}: $(file "${appimage_path}")" >&2
  exit 1
fi

temp_base="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
temp_base="${temp_base%/}"
temp_root="$(mktemp -d "${temp_base}/flow-reader-appimage.XXXXXX")"
extracted_root="${temp_root}/squashfs-root"
app_data="${temp_root}/app-data"
epub_root="${temp_root}/epub"
epub_path="${temp_root}/appimage-open.epub"
app_log="${temp_root}/flow-reader.log"
app_pid=""
remove_temp=1

process_is_running() {
  local process_state=""
  kill -0 -- "$1" >/dev/null 2>&1 || return 1
  process_state="$(ps -o stat= -p "$1" 2>/dev/null || true)"
  [[ -n "${process_state}" && "${process_state:0:1}" != "Z" ]]
}

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )); then
    echo "Preserving failed Linux lifecycle diagnostics at ${temp_root}." >&2
    remove_temp=0
  fi
  if [[ -n "${app_pid}" ]] && process_is_running "${app_pid}"; then
    running_data_dir="$(tr '\0' '\n' < "/proc/${app_pid}/environ" 2>/dev/null | grep '^FLOW_READER_DATA_DIR=' || true)"
    if [[ "${running_data_dir}" != "FLOW_READER_DATA_DIR=${app_data}" ]]; then
      echo "Refusing to terminate unexpected process ${app_pid}." >&2
      remove_temp=0
      return
    fi
    kill -- "${app_pid}" >/dev/null 2>&1 || true
    for _ in {1..50}; do
      if ! process_is_running "${app_pid}"; then
        break
      fi
      sleep 0.1
    done
    if process_is_running "${app_pid}"; then
      echo "Flow Reader did not exit; preserving temporary files at ${temp_root}." >&2
      remove_temp=0
    fi
  fi
  if [[ -n "${app_pid}" ]] && ! process_is_running "${app_pid}"; then
    wait "${app_pid}" 2>/dev/null || true
    app_pid=""
  fi

  if [[ "${remove_temp}" == "1" ]]; then
    case "${temp_root}" in
      "${temp_base}"/flow-reader-appimage.*)
        rm -rf -- "${temp_root}"
        ;;
      *)
        echo "Refusing to remove unexpected temporary directory: ${temp_root}" >&2
        ;;
    esac
  fi
}
trap cleanup EXIT

mkdir -p "${app_data}" "${epub_root}/META-INF" "${epub_root}/EPUB"
(
  cd "${temp_root}"
  "${appimage_path}" --appimage-extract >/dev/null
)

mapfile -t desktop_files < <(find -L "${extracted_root}" -maxdepth 2 -type f -name '*.desktop' -print)
if [[ "${#desktop_files[@]}" -ne 1 ]]; then
  echo "Expected one AppImage desktop entry, found ${#desktop_files[@]}." >&2
  exit 1
fi
desktop_file="${desktop_files[0]}"
desktop-file-validate "${desktop_file}"
grep -Fxq 'Name=Flow Reader' "${desktop_file}"
mime_line="$(grep -E '^MimeType=' "${desktop_file}" || true)"
if [[ ";${mime_line#MimeType=}" != *';application/epub+zip;'* ]]; then
  echo "Flow Reader desktop entry does not declare application/epub+zip." >&2
  exit 1
fi
exec_line="$(grep -E '^Exec=' "${desktop_file}" || true)"
if [[ "${exec_line}" != *'%F'* && "${exec_line}" != *'%U'* ]]; then
  echo "Flow Reader desktop entry does not pass selected filesystem paths: ${exec_line}" >&2
  exit 1
fi
if ! find "${extracted_root}/usr/share/icons" -type f -print -quit | grep -q .; then
  echo "The AppImage does not contain an application icon." >&2
  exit 1
fi
if find "${extracted_root}" -type f \( -name '*.thumbnailer' -o -path '*/thumbnailers/*' \) -print -quit | grep -q .; then
  echo "The Linux package must not claim unsupported thumbnailer integration." >&2
  exit 1
fi

printf '%s' 'application/epub+zip' > "${epub_root}/mimetype"
printf '%s' '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' > "${epub_root}/META-INF/container.xml"
printf '%s' '<?xml version="1.0" encoding="UTF-8"?><package version="3.0" unique-identifier="book-id" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">flow-reader-appimage-test</dc:identifier><dc:title>AppImage open lifecycle</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>' > "${epub_root}/EPUB/package.opf"
printf '%s' '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>AppImage open lifecycle</title></head><body><p>Flow Reader AppImage lifecycle test.</p></body></html>' > "${epub_root}/EPUB/chapter.xhtml"
(
  cd "${epub_root}"
  zip -q -X -0 "${epub_path}" mimetype
  zip -q -X "${epub_path}" META-INF/container.xml EPUB/package.opf EPUB/chapter.xhtml
)

if [[ -z "${DISPLAY:-}" ]]; then
  echo "Linux runtime validation requires a DISPLAY; run it through xvfb-run." >&2
  exit 1
fi

# Run the packaged entrypoint directly so app_pid tracks the application rather
# than the outer AppImage extraction or FUSE runtime.
FLOW_READER_DATA_DIR="${app_data}" \
WEBKIT_DISABLE_COMPOSITING_MODE=1 \
WEBKIT_DISABLE_DMABUF_RENDERER=1 \
"${extracted_root}/AppRun" "${epub_path}" >"${app_log}" 2>&1 &
app_pid=$!

library_file="${app_data}/library.json"
for _ in {1..120}; do
  if [[ -f "${library_file}" ]] && grep -Fq "${epub_path}" "${library_file}"; then
    echo "Linux AppImage direct EPUB opening passed."
    exit 0
  fi
  if ! process_is_running "${app_pid}"; then
    if wait "${app_pid}"; then
      app_status=0
    else
      app_status=$?
    fi
    app_pid=""
    remove_temp=0
    echo "Flow Reader exited with status ${app_status} before recording the EPUB path; preserving ${temp_root}." >&2
    cat "${app_log}" >&2
    exit 1
  fi
  sleep 0.5
done

remove_temp=0
echo "Flow Reader did not open the EPUB path supplied to the AppImage; preserving ${temp_root}." >&2
cat "${app_log}" >&2
exit 1
