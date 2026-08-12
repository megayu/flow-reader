import Foundation
import QuickLookThumbnailing

final class ThumbnailProvider: QLThumbnailProvider {
    private let renderingQueue = DispatchQueue(
        label: "com.flow.reader.thumbnail.rendering",
        qos: .userInitiated
    )

    override func provideThumbnail(
        for request: QLFileThumbnailRequest,
        _ handler: @escaping (QLThumbnailReply?, Error?) -> Void
    ) {
        let fileURL = request.fileURL
        let maximumSize = CGSize(
            width: max(request.maximumSize.width, request.minimumSize.width),
            height: max(request.maximumSize.height, request.minimumSize.height)
        )
        let scale = max(request.scale, 1)

        renderingQueue.async {
            autoreleasepool {
                do {
                    let thumbnail = try RustThumbnail(
                        fileURL: fileURL,
                        maximumSize: maximumSize,
                        scale: scale
                    )
                    let image = try thumbnail.makeImage()
                    let contextSize = CGSize(
                        width: CGFloat(thumbnail.width) / scale,
                        height: CGFloat(thumbnail.height) / scale
                    )
                    let reply = QLThumbnailReply(contextSize: contextSize) { context in
                        withExtendedLifetime(thumbnail) {
                            context.interpolationQuality = .high
                            context.draw(
                                image,
                                in: CGRect(origin: .zero, size: contextSize)
                            )
                        }
                        return true
                    }
                    handler(reply, nil)
                } catch {
                    handler(nil, error)
                }
            }
        }
    }
}
