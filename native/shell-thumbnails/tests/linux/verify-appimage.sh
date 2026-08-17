#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
native_dir="$(cd "${script_dir}/../.." && pwd)"
repo_dir="$(cd "${native_dir}/../.." && pwd)"
appimage_path="${1:-}"
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
if ! file "${appimage_path}" | grep -Eq 'ELF 64-bit.*x86-64'; then
  echo "The first Flow Reader AppImage must target x86_64." >&2
  exit 1
fi

temp_base="${TMPDIR:-/tmp}"
temp_base="${temp_base%/}"
temp_root="$(mktemp -d "${temp_base}/flow-reader-appimage.XXXXXX")"
extracted_root="${temp_root}/squashfs-root"
app_data="${temp_root}/app-data"
epub_root="${temp_root}/epub"
epub_path="${temp_root}/appimage-open.epub"
app_log="${temp_root}/flow-reader.log"
app_pid=""
remove_temp=1

cleanup() {
  if [[ -n "${app_pid}" ]] && kill -0 -- "-${app_pid}" >/dev/null 2>&1; then
    running_data_dir="$(tr '\0' '\n' < "/proc/${app_pid}/environ" 2>/dev/null | grep '^FLOW_READER_DATA_DIR=' || true)"
    if [[ "${running_data_dir}" != "FLOW_READER_DATA_DIR=${app_data}" ]]; then
      echo "Refusing to terminate unexpected process group ${app_pid}." >&2
      remove_temp=0
      return
    fi
    kill -- "-${app_pid}" >/dev/null 2>&1 || true
    for _ in {1..50}; do
      if ! kill -0 -- "-${app_pid}" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    if kill -0 -- "-${app_pid}" >/dev/null 2>&1; then
      echo "Flow Reader did not exit; preserving temporary files at ${temp_root}." >&2
      remove_temp=0
    fi
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

mkdir -p "${app_data}" "${epub_root}/META-INF"
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

printf '%s' '<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>' > "${epub_root}/META-INF/container.xml"
printf '%s' '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>AppImage open lifecycle</dc:title><dc:creator>Flow Reader</dc:creator></metadata><manifest/></package>' > "${epub_root}/package.opf"
(
  cd "${epub_root}"
  zip -q -X "${epub_path}" META-INF/container.xml package.opf
)

if [[ -z "${DISPLAY:-}" ]]; then
  echo "Linux runtime validation requires a DISPLAY; run it through xvfb-run." >&2
  exit 1
fi

APPIMAGE_EXTRACT_AND_RUN=1 \
FLOW_READER_DATA_DIR="${app_data}" \
WEBKIT_DISABLE_COMPOSITING_MODE=1 \
WEBKIT_DISABLE_DMABUF_RENDERER=1 \
setsid "${appimage_path}" "${epub_path}" >"${app_log}" 2>&1 &
app_pid=$!

external_index="${app_data}/external-books/index.json"
for _ in {1..120}; do
  if [[ -f "${external_index}" ]] && grep -Fq "${epub_path}" "${external_index}"; then
    echo "Linux AppImage direct EPUB opening passed."
    exit 0
  fi
  if ! kill -0 -- "-${app_pid}" >/dev/null 2>&1; then
    echo "Flow Reader exited before recording the EPUB path." >&2
    cat "${app_log}" >&2
    exit 1
  fi
  sleep 0.5
done

echo "Flow Reader did not open the EPUB path supplied to the AppImage." >&2
cat "${app_log}" >&2
exit 1
