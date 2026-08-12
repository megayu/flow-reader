#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
native_dir="$(cd "${script_dir}/.." && pwd)"
manifest_path="${native_dir}/Cargo.toml"
dist_dir="${native_dir}/dist/macos"
derived_data="${dist_dir}/DerivedData"

mkdir -p "${dist_dir}"

for target in x86_64-apple-darwin aarch64-apple-darwin; do
  if ! rustup target list --installed | grep -qx "${target}"; then
    echo "missing Rust target: ${target}" >&2
    exit 1
  fi
  cargo build \
    --locked \
    --release \
    --manifest-path "${manifest_path}" \
    --package flow-macos-thumbnail-ffi \
    --target "${target}"
done

lipo -create \
  "${native_dir}/target/x86_64-apple-darwin/release/libflow_thumbnail_macos.a" \
  "${native_dir}/target/aarch64-apple-darwin/release/libflow_thumbnail_macos.a" \
  -output "${dist_dir}/libflow_thumbnail_macos.a"

plutil -lint "${script_dir}/FlowReaderThumbnail/Info.plist"
lipo -info "${dist_dir}/libflow_thumbnail_macos.a"

xcodebuild \
  -project "${script_dir}/FlowReaderThumbnail.xcodeproj" \
  -scheme FlowReaderThumbnail \
  -configuration Release \
  -derivedDataPath "${derived_data}" \
  ARCHS="arm64 x86_64" \
  ONLY_ACTIVE_ARCH=NO \
  MACOSX_DEPLOYMENT_TARGET=10.15 \
  CODE_SIGNING_ALLOWED="${FLOW_CODE_SIGNING_ALLOWED:-NO}" \
  build

extension_path="${derived_data}/Build/Products/Release/FlowReaderThumbnail.appex"
test -d "${extension_path}"
lipo -info "${extension_path}/Contents/MacOS/FlowReaderThumbnail"
echo "${extension_path}"
