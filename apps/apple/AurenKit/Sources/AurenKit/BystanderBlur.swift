// Bystander blur, on this device, before anything is uploaded. Apple Vision's
// person segmentation finds the people in the photo, and they're pixelated and
// blurred out. The photo is also turned upright, resized and re-encoded, which
// drops its metadata, location included. If segmentation fails, nothing is sent.
// Not on watchOS, which has no Core Image; the watch has no camera anyway.
#if !os(watchOS)
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

/// Finds the people in a photo: a mask that's white where a person is and black elsewhere, at any size.
public protocol PersonSegmenter: Sendable {
    func personMask(for image: CGImage) throws -> CIImage
}

public struct VisionPersonSegmenter: PersonSegmenter {
    public init() {}

    public func personMask(for image: CGImage) throws -> CIImage {
        let request = VNGeneratePersonSegmentationRequest()
        request.qualityLevel = .accurate
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8
        try VNImageRequestHandler(cgImage: image).perform([request])
        guard let mask = request.results?.first?.pixelBuffer else {
            throw CaptureFailure("Couldn't check the photo for people, so it wasn't sent.")
        }
        return CIImage(cvPixelBuffer: mask)
    }
}

/// What's uploaded: a JPEG with people blurred and no metadata.
public struct PreparedFrame: Sendable {
    public let jpeg: Data
    public let width: Int
    public let height: Int
}

public enum BystanderBlur {
    /// The long side of an uploaded frame. Enough to read a poster, and well under Core's 2 MB cap.
    public static let maxPixelSize = 1280

    /// The camera's photo in; an upright, resized JPEG out, with every person blurred and no metadata.
    public static func prepare(_ photo: Data, maxPixelSize: Int = maxPixelSize, quality: Double = 0.8,
                               segmenter: any PersonSegmenter = VisionPersonSegmenter()) throws -> PreparedFrame {
        guard let image = decode(photo, maxPixelSize: maxPixelSize) else { throw CaptureFailure("The camera's photo couldn't be read.") }
        let mask = try segmenter.personMask(for: image)
        guard let blurred = blur(image, where: mask), let jpeg = encode(blurred, quality: quality) else {
            throw CaptureFailure("Couldn't blur the photo, so it wasn't sent.")
        }
        return PreparedFrame(jpeg: jpeg, width: blurred.width, height: blurred.height)
    }

    /// Pixelates and blurs `image` wherever `mask` is white. The mask is scaled to the image and
    /// grown a little, so the edges of a person are covered too.
    public static func blur(_ image: CGImage, where mask: CIImage) -> CGImage? {
        let input = CIImage(cgImage: image)
        let extent = input.extent
        guard mask.extent.width > 0, mask.extent.height > 0 else { return nil }
        let side = max(extent.width, extent.height)
        let fitted = mask.transformed(by: CGAffineTransform(scaleX: extent.width / mask.extent.width, y: extent.height / mask.extent.height))
        let grow = CIFilter.morphologyMaximum()
        grow.inputImage = fitted.clampedToExtent()
        grow.radius = Float(side / 100)
        let pixellate = CIFilter.pixellate()
        pixellate.inputImage = input.clampedToExtent()
        pixellate.scale = Float(side / 40)
        pixellate.center = .zero
        let blend = CIFilter.blendWithMask()
        blend.inputImage = pixellate.outputImage?.applyingGaussianBlur(sigma: side / 80)
        blend.backgroundImage = input
        blend.maskImage = grow.outputImage
        guard let out = blend.outputImage?.cropped(to: extent) else { return nil }
        return CIContext(options: [.cacheIntermediates: false]).createCGImage(out, from: extent)
    }

    static func decode(_ data: Data, maxPixelSize: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true, // upright, from the camera's orientation tag
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// A JPEG with no metadata: nothing about where or when the photo was taken leaves the device.
    static func encode(_ image: CGImage, quality: Double) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
}
#endif
