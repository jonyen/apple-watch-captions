import Foundation

/// An event produced by a captioning engine.
public enum CaptionEvent: Equatable {
    case ready
    case caption(text: String, isFinal: Bool, channel: Int?)
    case error(message: String)
}