import CoreGraphics
import Foundation

enum RustThumbnailError: Error {
    case renderFailed(Int, String)
    case invalidPixels
}

final class RustThumbnail {
    private var output: FlowThumbnailOutput

    let width: Int
    let height: Int

    init(fileURL: URL, maximumSize: CGSize, scale: CGFloat) throws {
        var output = FlowThumbnailOutput(
            pixels: nil,
            len: 0,
            width: 0,
            height: 0,
            stride: 0,
            has_alpha: 0
        )
        let path = Array(fileURL.path.utf8)
        let request = FlowThumbnailRequest(
            max_width: UInt32(max(1, ceil(maximumSize.width))),
            max_height: UInt32(max(1, ceil(maximumSize.height))),
            scale: Float(scale)
        )
        let status = path.withUnsafeBufferPointer { pathBuffer in
            flow_thumbnail_render_file(
                pathBuffer.baseAddress,
                pathBuffer.count,
                request,
                &output
            )
        }
        guard status.rawValue == 0 else {
            throw RustThumbnailError.renderFailed(
                Int(status.rawValue),
                Self.statusMessage(Int32(status.rawValue))
            )
        }
        guard output.pixels != nil,
              output.len == Int(output.stride) * Int(output.height),
              output.stride == Int(output.width) * 4 else {
            flow_thumbnail_free(&output)
            throw RustThumbnailError.invalidPixels
        }

        self.output = output
        width = Int(output.width)
        height = Int(output.height)
    }

    deinit {
        flow_thumbnail_free(&output)
    }

    func makeImage() throws -> CGImage {
        guard let pixels = output.pixels,
              let provider = CGDataProvider(
                  dataInfo: nil,
                  data: pixels,
                  size: output.len,
                  releaseData: { _, _, _ in }
              ) else {
            throw RustThumbnailError.invalidPixels
        }
        let alphaInfo: CGImageAlphaInfo = output.has_alpha == 0 ? .noneSkipLast : .last
        let bitmapInfo = CGBitmapInfo(rawValue: alphaInfo.rawValue)
            .union(.byteOrder32Big)
        guard let image = CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: output.stride,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: bitmapInfo,
            provider: provider,
            decode: nil,
            shouldInterpolate: true,
            intent: .defaultIntent
        ) else {
            throw RustThumbnailError.invalidPixels
        }
        return image
    }

    private static func statusMessage(_ status: Int32) -> String {
        var length = 0
        guard let bytes = flow_thumbnail_status_message(status, &length) else {
            return "Unknown thumbnail error"
        }
        return String(decoding: UnsafeBufferPointer(start: bytes, count: length), as: UTF8.self)
    }
}
