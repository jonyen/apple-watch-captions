import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var capturing = false

    func toggle() {
        capturing.toggle()
    }
}
