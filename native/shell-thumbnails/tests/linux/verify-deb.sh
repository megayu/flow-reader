#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Linux DEB lifecycle validation requires Linux." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
native_dir="$(cd "${script_dir}/../.." && pwd)"
repo_dir="$(cd "${native_dir}/../.." && pwd)"
deb_path="${1:-}"
if [[ -z "${deb_path}" ]]; then
  deb_path="$(find "${repo_dir}/src-tauri/target/release/bundle/deb" -maxdepth 1 -type f -name '*.deb' -print -quit 2>/dev/null || true)"
fi
if [[ -z "${deb_path}" || ! -f "${deb_path}" ]]; then
  echo "Flow Reader DEB does not exist: ${deb_path:-<unspecified>}" >&2
  exit 1
fi
deb_path="$(realpath "${deb_path}")"

temp_base="${TMPDIR:-/tmp}"
temp_base="${temp_base%/}"
temp_root="$(mktemp -d "${temp_base}/flow-reader-deb-lifecycle.XXXXXX")"
extracted_root="${temp_root}/extracted"
app_data="${temp_root}/app-data"
epub_root="${temp_root}/epub"
epub_path="${temp_root}/desktop-open.epub"
app_log="${temp_root}/flow-reader.log"
app_pid=""
app_binary=""
remove_temp=1

cleanup() {
  if [[ -n "${app_pid}" ]] && kill -0 "${app_pid}" >/dev/null 2>&1; then
    running_binary="$(readlink -f "/proc/${app_pid}/exe" 2>/dev/null || true)"
    expected_binary="$(readlink -f "${app_binary}" 2>/dev/null || true)"
    if [[ -n "${expected_binary}" && "${running_binary}" == "${expected_binary}" ]]; then
      kill "${app_pid}" >/dev/null 2>&1 || true
      for _ in {1..50}; do
        if ! kill -0 "${app_pid}" >/dev/null 2>&1; then
          break
        fi
        sleep 0.1
      done
      if kill -0 "${app_pid}" >/dev/null 2>&1; then
        echo "Flow Reader did not exit; preserving temporary files at ${temp_root}." >&2
        remove_temp=0
      fi
    else
      echo "Refusing to terminate unexpected process ${app_pid}: ${running_binary}" >&2
      remove_temp=0
    fi
  fi

  if [[ "${remove_temp}" == "1" ]]; then
    case "${temp_root}" in
      "${temp_base}"/flow-reader-deb-lifecycle.*)
        rm -rf -- "${temp_root}"
        ;;
      *)
        echo "Refusing to remove unexpected temporary directory: ${temp_root}" >&2
        ;;
    esac
  fi
}
trap cleanup EXIT

mkdir -p "${extracted_root}" "${app_data}" "${epub_root}/META-INF"
dpkg-deb --extract "${deb_path}" "${extracted_root}"

if [[ "$(dpkg-deb --field "${deb_path}" Architecture)" != "amd64" ]]; then
  echo "The first Flow Reader Linux package must target amd64." >&2
  exit 1
fi

mapfile -t desktop_files < <(find "${extracted_root}/usr/share/applications" -maxdepth 1 -type f -name '*.desktop' -print)
if [[ "${#desktop_files[@]}" -ne 1 ]]; then
  echo "Expected one desktop entry, found ${#desktop_files[@]}." >&2
  exit 1
fi
desktop_file="${desktop_files[0]}"
desktop-file-validate "${desktop_file}"

grep -Fxq 'Name=Flow Reader' "${desktop_file}"
mime_line="$(grep -E '^MimeType=' "${desktop_file}" || true)"
if [[ ";${mime_line#MimeType=}" != *';application/epub+zip;'* ]]; then
  echo "Flow Reader desktop entry does not register application/epub+zip." >&2
  exit 1
fi
exec_line="$(grep -E '^Exec=' "${desktop_file}" || true)"
if [[ "${exec_line}" != *'%F'* ]]; then
  echo "Flow Reader desktop entry does not pass selected filesystem paths to the executable: ${exec_line}" >&2
  exit 1
fi
icon_name="$(grep -E '^Icon=' "${desktop_file}" | cut -d= -f2- || true)"
if [[ -z "${icon_name}" ]]; then
  echo "Flow Reader desktop entry does not declare an icon." >&2
  exit 1
fi

mapfile -t app_binaries < <(find "${extracted_root}/usr/bin" -maxdepth 1 -type f -perm -111 -print)
if [[ "${#app_binaries[@]}" -ne 1 ]]; then
  echo "Expected one installed application binary, found ${#app_binaries[@]}." >&2
  exit 1
fi
app_binary="${app_binaries[0]}"
if [[ "${exec_line}" != *"$(basename "${app_binary}")"* ]]; then
  echo "Desktop Exec does not reference the installed Flow Reader binary: ${exec_line}" >&2
  exit 1
fi
if ! find "${extracted_root}/usr/share/icons" -type f -print -quit | grep -q .; then
  echo "The DEB does not contain an application icon." >&2
  exit 1
fi
if find "${extracted_root}" -type f \( -name '*.thumbnailer' -o -path '*/thumbnailers/*' \) -print -quit | grep -q .; then
  echo "The Linux package must not claim non-portable thumbnailer support." >&2
  exit 1
fi

printf '%s' '<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>' > "${epub_root}/META-INF/container.xml"
printf '%s' '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Desktop open lifecycle</dc:title><dc:creator>Flow Reader</dc:creator></metadata><manifest/></package>' > "${epub_root}/package.opf"
(
  cd "${epub_root}"
  zip -q -X "${epub_path}" META-INF/container.xml package.opf
)

if [[ -z "${DISPLAY:-}" ]]; then
  echo "Linux runtime validation requires a DISPLAY; run it through xvfb-run." >&2
  exit 1
fi

FLOW_READER_DATA_DIR="${app_data}" \
WEBKIT_DISABLE_COMPOSITING_MODE=1 \
WEBKIT_DISABLE_DMABUF_RENDERER=1 \
"${app_binary}" "${epub_path}" >"${app_log}" 2>&1 &
app_pid=$!

external_index="${app_data}/external-books/index.json"
for _ in {1..120}; do
  if [[ -f "${external_index}" ]] && grep -Fq "${epub_path}" "${external_index}"; then
    echo "Linux DEB file association and direct EPUB opening passed."
    exit 0
  fi
  if ! kill -0 "${app_pid}" >/dev/null 2>&1; then
    echo "Flow Reader exited before recording the EPUB path." >&2
    cat "${app_log}" >&2
    exit 1
  fi
  sleep 0.5
done

echo "Flow Reader did not open the EPUB path supplied by the desktop entry contract." >&2
cat "${app_log}" >&2
exit 1
