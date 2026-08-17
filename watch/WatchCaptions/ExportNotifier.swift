import Foundation
import UserNotifications
import CaptionRelay

/// Tells you on the wrist that a finished transcript reached Notion.
///
/// The export happens minutes after the conversation, long after the captions
/// screen is gone, so there is no screen left to put this on — a notification
/// is the only place it can land.
final class ExportNotifier: NSObject, UNUserNotificationCenterDelegate {
    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
        super.init()
        center.delegate = self
    }

    /// Asked for at the end of the first session rather than at launch: a
    /// permission prompt makes sense once there is something waiting to be
    /// announced, and reads as noise before the app has done anything.
    func requestAuthorization() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
    }

    func notify(_ exported: ExportedTranscript) async {
        let content = UNMutableNotificationContent()
        content.title = "Saved to Notion"
        // The topic if the summary produced one; otherwise say the plain thing
        // rather than show an empty line.
        content.body = exported.title ?? "Your transcript is ready."
        content.sound = .default
        if let url = exported.url { content.userInfo = ["url": url] }

        // Keyed by transcript, so a duplicate wake cannot announce it twice.
        let request = UNNotificationRequest(
            identifier: "notion-export-\(exported.name)", content: content, trigger: nil)
        try? await center.add(request)
    }

    /// Show it even with the app on screen — the wait it ends is very likely
    /// why the app is still open.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
