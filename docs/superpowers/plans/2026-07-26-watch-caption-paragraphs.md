# Resumed Transcripts and Flowing Paragraphs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A resumed session shows the transcript it is resuming, and captions flow as paragraphs that break only on a real pause.

**Architecture:** All of it is client-side. A new pure `Paragraphs.swift` in the `CaptionCore` package owns the one join rule and both pause thresholds; `CaptionStore` applies that rule incrementally to live captions using message-arrival times, and `buildParagraphs` applies it to stored segments using the `at` timestamps the relay already writes. `SessionController` gains an optional `HistoryClient` and fires a non-awaited fetch on resume that prepends the stored transcript.

**Tech Stack:** Swift 5.9, SwiftUI, XCTest, Swift Package Manager (`CaptionCore`), XcodeGen for the two app projects.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-watch-caption-paragraphs-design.md`. Read it before starting.
- `CaptionCore` targets watchOS 10 / iOS 16 / macOS 13 and has **zero external dependencies**. Foundation and Combine only. Do not add a package.
- **No backend, relay, or provider changes.** Pause detection is client-side by design. Do not touch anything under `backend/`.
- Thresholds are exactly `livePauseThreshold = 3` seconds and `storedPauseThreshold = 8` seconds.
- `CaptionCore` is shared by **both** the watch app and the mac app. Every change to it must leave `mac/MacCaptions` compiling.
- Logic tests live in `CaptionCore` and run with `cd watch/CaptionCore && swift test`. The app targets have no unit tests for this feature.
- Follow the existing comment style: comments explain *why*, not *what*. Match the surrounding density — sparse, one or two lines, no section banners.

## File Structure

**Created:**
- `watch/CaptionCore/Sources/CaptionCore/Paragraphs.swift` — `CaptionParagraph`, the two thresholds, `buildParagraphs`, the shared `append` join rule, `parseISODate`. Pure functions, no state.
- `watch/CaptionCore/Tests/CaptionCoreTests/ParagraphsTests.swift` — tests for the above.

**Modified:**
- `watch/CaptionCore/Sources/CaptionCore/History.swift` — `TranscriptSegment` gains `at`; `decodeTranscriptDetail` decodes it; `TranscriptRow.format` uses the shared `parseISODate`.
- `watch/CaptionCore/Sources/CaptionCore/CaptionStore.swift` — `lines` becomes `paragraphs`; injectable clock; pause detection; `prepend`.
- `watch/CaptionCore/Sources/CaptionCore/SessionController.swift` — optional `HistoryClient`, restore-on-resume.
- `watch/WatchCaptions/Views/CaptionView.swift` — paragraph rendering, inline partial.
- `watch/WatchCaptions/Views/TranscriptDetailView.swift` — paragraph rendering.
- `watch/WatchCaptions/AppModel.swift` — pass the history client to `SessionController`.
- `mac/MacCaptions/CaptionPanel.swift` — one line, `lines` → `paragraphs`. Behaviour unchanged.
- `watch/README.md` — describe the new caption behaviour.
- Test files: `TranscriptDecodingTests.swift`, `CaptionStoreTests.swift`, `SessionControllerTests.swift`.

---

### Task 1: `TranscriptSegment` carries its timestamp

The relay already returns an `at` field on every stored segment; the decoder drops it. Paragraph breaks in restored history need it.

**Files:**
- Modify: `watch/CaptionCore/Sources/CaptionCore/History.swift:25-38` (`TranscriptSegment`) and `:226-232` (`decodeTranscriptDetail`)
- Test: `watch/CaptionCore/Tests/CaptionCoreTests/TranscriptDecodingTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `TranscriptSegment.at: String?` and `TranscriptSegment.init(text: String, channel: Int?, at: String? = nil)`. Tasks 2, 3, and 4 all rely on both.

- [ ] **Step 1: Write the failing test**

Append to `TranscriptDecodingTests.swift`, inside the existing test class:

```swift
    func testDetailDecodesSegmentTimestamps() {
        let json: [String: Any] = [
            "segments": [
                ["at": "2026-07-10T18:05:22Z", "text": "hello"],
                ["text": "no timestamp"],
            ],
        ]

        let detail = decodeTranscriptDetail(json, name: "2026-07-10T18-05-22Z_f9dd")

        XCTAssertEqual(detail.segments.map(\.at), ["2026-07-10T18:05:22Z", nil])
    }
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd watch/CaptionCore && swift test --filter testDetailDecodesSegmentTimestamps
```

Expected: FAIL to compile — `value of type 'TranscriptSegment' has no member 'at'`.

- [ ] **Step 3: Add the field and decode it**

Replace `TranscriptSegment` in `History.swift` (currently lines 25-38) with:

```swift
public struct TranscriptSegment: Equatable, Identifiable, Sendable {
    public let id = UUID()
    public let text: String
    public let channel: Int?
    /// ISO 8601 time the final caption arrived, as the relay stores it. Absent
    /// on rows written before the relay recorded it, and in tests that do not
    /// care about timing.
    public let at: String?

    public init(text: String, channel: Int?, at: String? = nil) {
        self.text = text
        self.channel = channel
        self.at = at
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.text == rhs.text && lhs.channel == rhs.channel && lhs.at == rhs.at
    }
}
```

In `decodeTranscriptDetail` (currently line 227), add the `at:` argument:

```swift
    let segments = (json["segments"] as? [[String: Any]] ?? []).map { segment in
        TranscriptSegment(text: segment["text"] as? String ?? "",
                          channel: segment["channel"] as? Int,
                          at: segment["at"] as? String)
    }
```

- [ ] **Step 4: Run the whole suite to verify it passes**

```bash
cd watch/CaptionCore && swift test
```

Expected: PASS, all tests. The `at` field is now part of `==`; if an existing test compares a hand-built segment against a decoded one it will fail here — fix it by passing the same `at` to the hand-built segment, not by removing `at` from `==`.

- [ ] **Step 5: Commit**

```bash
git add watch/CaptionCore/Sources/CaptionCore/History.swift \
        watch/CaptionCore/Tests/CaptionCoreTests/TranscriptDecodingTests.swift
git commit -m "feat(watch): keep the timestamp on a decoded transcript segment"
```

---

### Task 2: The paragraph model and the stored-transcript builder

**Files:**
- Create: `watch/CaptionCore/Sources/CaptionCore/Paragraphs.swift`
- Create: `watch/CaptionCore/Tests/CaptionCoreTests/ParagraphsTests.swift`
- Modify: `watch/CaptionCore/Sources/CaptionCore/History.swift:104-118` (`TranscriptRow.format`, to use the shared date parser)

**Interfaces:**
- Consumes: `TranscriptSegment.at` from Task 1.
- Produces:
  - `CaptionParagraph` — `id: UUID`, `channel: Int?`, `var text: String`, `init(id: UUID = UUID(), channel: Int?, text: String)`
  - `livePauseThreshold: TimeInterval` = 3, `storedPauseThreshold: TimeInterval` = 8
  - `buildParagraphs(from: [TranscriptSegment], pauseThreshold: TimeInterval = storedPauseThreshold) -> [CaptionParagraph]`
  - `append(_ text: String, channel: Int?, startingParagraph: Bool, to: inout [CaptionParagraph])` (internal — Task 3 uses it)
  - `parseISODate(_ iso: String) -> Date?` (internal)

- [ ] **Step 1: Write the failing tests**

Create `watch/CaptionCore/Tests/CaptionCoreTests/ParagraphsTests.swift`:

```swift
import XCTest
@testable import CaptionCore

final class ParagraphsTests: XCTestCase {
    private func segment(_ text: String, _ at: String?, channel: Int? = nil) -> TranscriptSegment {
        TranscriptSegment(text: text, channel: channel, at: at)
    }

    func testJoinsSegmentsInsideTheThresholdIntoOneParagraph() {
        let paragraphs = buildParagraphs(from: [
            segment("i went to the store", "2026-07-10T18:00:00Z"),
            segment("and it was closed", "2026-07-10T18:00:04Z"),
        ])

        XCTAssertEqual(paragraphs.map(\.text), ["i went to the store and it was closed"])
    }

    func testBreaksOnAGapPastTheThreshold() {
        let paragraphs = buildParagraphs(from: [
            segment("so that happened", "2026-07-10T18:00:00Z"),
            segment("anyway where were we", "2026-07-10T18:00:20Z"),
        ])

        XCTAssertEqual(paragraphs.map(\.text), ["so that happened", "anyway where were we"])
    }

    func testAGapExactlyAtTheThresholdBreaks() {
        let paragraphs = buildParagraphs(from: [
            segment("one", "2026-07-10T18:00:00Z"),
            segment("two", "2026-07-10T18:00:08Z"),
        ])

        XCTAssertEqual(paragraphs.map(\.text), ["one", "two"])
    }

    func testBreaksOnAChannelChange() {
        let paragraphs = buildParagraphs(from: [
            segment("my turn", "2026-07-10T18:00:00Z", channel: 0),
            segment("their turn", "2026-07-10T18:00:01Z", channel: 1),
        ])

        XCTAssertEqual(paragraphs.map(\.text), ["my turn", "their turn"])
        XCTAssertEqual(paragraphs.map(\.channel), [0, 1])
    }

    func testSegmentsWithoutTimestampsStayInOneParagraph() {
        let paragraphs = buildParagraphs(from: [segment("one", nil), segment("two", nil)])

        XCTAssertEqual(paragraphs.map(\.text), ["one two"])
    }

    func testMeasuresTheGapFromTheLastSegmentThatHadATimestamp() {
        let paragraphs = buildParagraphs(from: [
            segment("one", "2026-07-10T18:00:00Z"),
            segment("two", nil),
            segment("three", "2026-07-10T18:00:30Z"),
        ])

        XCTAssertEqual(paragraphs.map(\.text), ["one two", "three"])
    }

    func testParsesFractionalSecondTimestamps() {
        let paragraphs = buildParagraphs(from: [
            segment("one", "2026-07-10T18:00:00.500Z"),
            segment("two", "2026-07-10T18:00:20.250Z"),
        ])

        XCTAssertEqual(paragraphs.map(\.text), ["one", "two"])
    }

    func testSkipsEmptySegments() {
        let paragraphs = buildParagraphs(from: [
            segment("", "2026-07-10T18:00:00Z"),
            segment("real", "2026-07-10T18:00:01Z"),
        ])

        XCTAssertEqual(paragraphs.map(\.text), ["real"])
    }

    func testNoSegmentsProduceNoParagraphs() {
        XCTAssertTrue(buildParagraphs(from: []).isEmpty)
    }

    func testEachParagraphGetsItsOwnIdentity() {
        let paragraphs = buildParagraphs(from: [
            segment("one", "2026-07-10T18:00:00Z"),
            segment("two", "2026-07-10T18:00:20Z"),
        ])

        XCTAssertNotEqual(paragraphs[0].id, paragraphs[1].id)
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd watch/CaptionCore && swift test --filter ParagraphsTests
```

Expected: FAIL to compile — `cannot find 'buildParagraphs' in scope`.

- [ ] **Step 3: Write the implementation**

Create `watch/CaptionCore/Sources/CaptionCore/Paragraphs.swift`:

```swift
import Foundation

/// A run of speech shown as one wrapping block of text. Speech-to-text
/// finalizes at utterance boundaries, which is far more often than a reader
/// wants a line break, so finals are joined until something says otherwise.
public struct CaptionParagraph: Identifiable, Equatable {
    public let id: UUID
    public let channel: Int?
    public var text: String

    public init(id: UUID = UUID(), channel: Int?, text: String) {
        self.id = id
        self.channel = channel
        self.text = text
    }
}

/// Silence long enough to start a new paragraph while captions are live.
///
/// Measured as the absence of *any* caption message. Partials arrive about once
/// per relay poll while someone is speaking, so a gap this long means nobody is.
/// The gap between two finals is not usable for this: it contains all of the
/// next utterance's speech, so a long sentence looks exactly like a pause.
public let livePauseThreshold: TimeInterval = 3

/// Gap between two stored finals' timestamps that starts a new paragraph.
///
/// Higher than the live threshold because a stored gap *is* the weaker signal
/// described above — all we have after the fact — so only an unambiguous one
/// counts. Finals land every few seconds during continuous speech; eight is
/// well clear of that.
public let storedPauseThreshold: TimeInterval = 8

/// Group stored segments into paragraphs, breaking on a long gap or a change of
/// speaker.
public func buildParagraphs(
    from segments: [TranscriptSegment],
    pauseThreshold: TimeInterval = storedPauseThreshold
) -> [CaptionParagraph] {
    var paragraphs: [CaptionParagraph] = []
    var previousAt: Date?

    for segment in segments where !segment.text.isEmpty {
        let at = segment.at.flatMap(parseISODate)
        var paused = false
        if let at, let previousAt {
            paused = at.timeIntervalSince(previousAt) >= pauseThreshold
        }
        append(segment.text, channel: segment.channel,
               startingParagraph: paused, to: &paragraphs)
        // Keep the last usable time, so one undated segment does not blind the
        // next comparison.
        previousAt = at ?? previousAt
    }
    return paragraphs
}

/// The one join rule, shared by the stored and the live path: continue the last
/// paragraph unless a break is called for or the speaker changed.
func append(_ text: String, channel: Int?, startingParagraph: Bool,
            to paragraphs: inout [CaptionParagraph]) {
    if !startingParagraph, let last = paragraphs.last, last.channel == channel {
        paragraphs[paragraphs.count - 1].text += " " + text
    } else {
        paragraphs.append(CaptionParagraph(channel: channel, text: text))
    }
}

/// Parse an ISO 8601 timestamp with or without fractional seconds. The relay
/// writes both shapes.
func parseISODate(_ iso: String) -> Date? {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = parser.date(from: iso) { return date }
    parser.formatOptions = [.withInternetDateTime]
    return parser.date(from: iso)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd watch/CaptionCore && swift test --filter ParagraphsTests
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Reuse the date parser in `TranscriptRow`**

`TranscriptRow.format` (`History.swift:104-118`) has the same two-format ISO parse inline. Replace its body's parsing with the shared helper, leaving the output formatting alone:

```swift
    /// `Jul 10, 6:05 PM`, or the raw value if it will not parse.
    static func format(_ iso: String, timeZone: TimeZone) -> String {
        guard let date = parseISODate(iso) else { return iso }

        let out = DateFormatter()
        out.locale = Locale(identifier: "en_US_POSIX")
        out.timeZone = timeZone
        out.dateFormat = "MMM d, h:mm a"
        return out.string(from: date)
    }
```

- [ ] **Step 6: Run the whole suite**

```bash
cd watch/CaptionCore && swift test
```

Expected: PASS, everything — the existing `TranscriptRow` tests cover the parser swap.

- [ ] **Step 7: Commit**

```bash
git add watch/CaptionCore/Sources/CaptionCore/Paragraphs.swift \
        watch/CaptionCore/Sources/CaptionCore/History.swift \
        watch/CaptionCore/Tests/CaptionCoreTests/ParagraphsTests.swift
git commit -m "feat(watch): group transcript segments into paragraphs"
```

---

### Task 3: `CaptionStore` builds paragraphs and detects live pauses

Replaces `lines` with `paragraphs`, built incrementally so only the last paragraph's text changes as captions arrive. Both app targets are adapted in the same task, mechanically, so every commit leaves them compiling — the polished views come later.

**Files:**
- Modify: `watch/CaptionCore/Sources/CaptionCore/CaptionStore.swift` (whole file)
- Modify: `watch/WatchCaptions/Views/CaptionView.swift:12,22` (mechanical)
- Modify: `mac/MacCaptions/CaptionPanel.swift:128` (mechanical)
- Test: `watch/CaptionCore/Tests/CaptionCoreTests/CaptionStoreTests.swift`

**Interfaces:**
- Consumes: `CaptionParagraph`, `append(_:channel:startingParagraph:to:)`, `livePauseThreshold`, `buildParagraphs` from Task 2; `TranscriptSegment.at` from Task 1.
- Produces:
  - `CaptionStore.paragraphs: [CaptionParagraph]` (`@Published`, `private(set)`) — replaces `lines`
  - `CaptionStore.init(now: @escaping () -> Date = Date.init, pauseThreshold: TimeInterval = livePauseThreshold)`
  - `CaptionStore.prepend(_ segments: [TranscriptSegment])` — Task 4 calls it
  - `CaptionLine` is **deleted**
  - `partials`, `partial`, `state`, `apply`, `reset`, `setError` keep their current signatures

- [ ] **Step 1: Update the existing tests to the new shape**

In `CaptionStoreTests.swift`, replace every `lines` reference. Five tests change:

```swift
    func testPartialSetsPartialLine() {
        let s = CaptionStore()
        s.apply(.caption(text: "hel", isFinal: false, channel: nil))
        XCTAssertEqual(s.partial, "hel")
        XCTAssertTrue(s.paragraphs.isEmpty)
    }

    func testFinalAppendsAndClearsPartial() {
        let s = CaptionStore()
        s.apply(.caption(text: "hel", isFinal: false, channel: nil))
        s.apply(.caption(text: "hello", isFinal: true, channel: nil))
        XCTAssertEqual(s.paragraphs.map(\.text), ["hello"])
        XCTAssertEqual(s.partial, "")
    }

    func testEmptyFinalIsNotAppended() {
        let s = CaptionStore()
        s.apply(.caption(text: "", isFinal: true, channel: nil))
        XCTAssertTrue(s.paragraphs.isEmpty)
    }

    func testResetClearsEverything() {
        let s = CaptionStore()
        s.apply(.caption(text: "hi", isFinal: true, channel: nil))
        s.apply(.ready)
        s.reset()
        XCTAssertTrue(s.paragraphs.isEmpty)
        XCTAssertEqual(s.partial, "")
        XCTAssertEqual(s.state, .connecting)
    }

    @MainActor func testTracksChannelsOnParagraphsAndPartials() {
        let store = CaptionStore()
        store.apply(.caption(text: "typing…", isFinal: false, channel: 1))
        XCTAssertEqual(store.partials[1], "typing…")
        store.apply(.caption(text: "done", isFinal: true, channel: 1))
        XCTAssertEqual(store.paragraphs.last?.text, "done")
        XCTAssertEqual(store.paragraphs.last?.channel, 1)
        XCTAssertEqual(store.partials[1], "")
    }
```

- [ ] **Step 2: Write the failing tests for pause detection and prepend**

Add to the top of `CaptionStoreTests.swift`, above the test class:

```swift
/// A clock the test advances by hand, so pause detection is deterministic.
private final class TestClock {
    var now = Date(timeIntervalSince1970: 1_000)
    func advance(_ seconds: TimeInterval) { now += seconds }
}
```

And add these tests inside the class:

```swift
    private func store(_ clock: TestClock) -> CaptionStore {
        CaptionStore(now: { clock.now })
    }

    func testConsecutiveFinalsJoinIntoOneParagraph() {
        let clock = TestClock()
        let s = store(clock)
        s.apply(.caption(text: "i went to the store", isFinal: true, channel: nil))
        clock.advance(1)
        s.apply(.caption(text: "and it was closed", isFinal: true, channel: nil))

        XCTAssertEqual(s.paragraphs.map(\.text), ["i went to the store and it was closed"])
    }

    func testAFinalAfterSilenceStartsANewParagraph() {
        let clock = TestClock()
        let s = store(clock)
        s.apply(.caption(text: "so that happened", isFinal: true, channel: nil))
        clock.advance(livePauseThreshold)
        s.apply(.caption(text: "anyway", isFinal: true, channel: nil))

        XCTAssertEqual(s.paragraphs.map(\.text), ["so that happened", "anyway"])
    }

    /// The gap is observed by the partial that reopens speech, not by the final
    /// that closes the new utterance — by then the partials have refreshed the
    /// arrival time. So the break has to be remembered when it is seen.
    func testAPartialObservingTheGapStillBreaksTheFinalAfterIt() {
        let clock = TestClock()
        let s = store(clock)
        s.apply(.caption(text: "so that happened", isFinal: true, channel: nil))
        clock.advance(5)
        s.apply(.caption(text: "any", isFinal: false, channel: nil))
        clock.advance(1)
        s.apply(.caption(text: "anyway where were we", isFinal: true, channel: nil))

        XCTAssertEqual(s.paragraphs.map(\.text), ["so that happened", "anyway where were we"])
    }

    /// A long sentence arrives as several finals with partials streaming
    /// throughout. None of it is a pause.
    func testSteadySpeechKeepsOneParagraphAcrossManyFinals() {
        let clock = TestClock()
        let s = store(clock)
        for word in ["one", "two", "three", "four"] {
            s.apply(.caption(text: word, isFinal: false, channel: nil))
            clock.advance(1)
            s.apply(.caption(text: word, isFinal: true, channel: nil))
            clock.advance(1)
        }

        XCTAssertEqual(s.paragraphs.map(\.text), ["one two three four"])
    }

    func testAChannelChangeStartsANewParagraph() {
        let clock = TestClock()
        let s = store(clock)
        s.apply(.caption(text: "my turn", isFinal: true, channel: 0))
        clock.advance(1)
        s.apply(.caption(text: "their turn", isFinal: true, channel: 1))

        XCTAssertEqual(s.paragraphs.map(\.text), ["my turn", "their turn"])
    }

    func testPrependPutsARestoredTranscriptFirst() {
        let s = CaptionStore()
        s.prepend([TranscriptSegment(text: "earlier talk", channel: nil,
                                     at: "2026-07-10T18:00:00Z")])
        s.apply(.caption(text: "back again", isFinal: true, channel: nil))

        XCTAssertEqual(s.paragraphs.map(\.text), ["earlier talk", "back again"])
    }

    func testPrependArrivingAfterLiveCaptionsStillGoesFirst() {
        let s = CaptionStore()
        s.apply(.caption(text: "back again", isFinal: true, channel: nil))
        s.prepend([TranscriptSegment(text: "earlier talk", channel: nil,
                                     at: "2026-07-10T18:00:00Z")])

        XCTAssertEqual(s.paragraphs.map(\.text), ["earlier talk", "back again"])
    }

    /// A late restore must not break the sentence the user is in the middle of.
    func testPrependArrivingAfterLiveCaptionsDoesNotBreakTheLiveParagraph() {
        let clock = TestClock()
        let s = store(clock)
        s.apply(.caption(text: "okay where were we", isFinal: true, channel: nil))
        s.prepend([TranscriptSegment(text: "earlier talk", channel: nil,
                                     at: "2026-07-10T18:00:00Z")])
        clock.advance(1)
        s.apply(.caption(text: "on the budget", isFinal: true, channel: nil))

        XCTAssertEqual(s.paragraphs.map(\.text),
                       ["earlier talk", "okay where were we on the budget"])
    }

    func testPrependingNothingChangesNothing() {
        let s = CaptionStore()
        s.prepend([])

        XCTAssertTrue(s.paragraphs.isEmpty)
    }

    func testResetClearsAPendingBreak() {
        let clock = TestClock()
        let s = store(clock)
        s.apply(.caption(text: "before", isFinal: true, channel: nil))
        clock.advance(30)
        s.apply(.caption(text: "gap seen here", isFinal: false, channel: nil))
        s.reset()
        s.apply(.caption(text: "one", isFinal: true, channel: nil))
        clock.advance(1)
        s.apply(.caption(text: "two", isFinal: true, channel: nil))

        XCTAssertEqual(s.paragraphs.map(\.text), ["one two"])
    }
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd watch/CaptionCore && swift test --filter CaptionStoreTests
```

Expected: FAIL to compile — no `paragraphs`, no `prepend`, and `CaptionStore.init` takes no arguments.

- [ ] **Step 4: Rewrite `CaptionStore`**

Replace the whole of `watch/CaptionCore/Sources/CaptionCore/CaptionStore.swift`:

```swift
import Foundation
import Combine

/// The screen the app shows, derived from session progress.
public enum CaptionState: Equatable {
    case connecting
    case listening
    case error(String)
}

/// Observable transcript + connection state. UI state only; mutate on the main actor.
@MainActor
public final class CaptionStore: ObservableObject {
    @Published public private(set) var paragraphs: [CaptionParagraph] = []
    @Published public private(set) var partials: [Int: String] = [:]
    @Published public private(set) var state: CaptionState = .connecting

    /// Mono convenience: the in-progress line for the (only) channel.
    public var partial: String { partials[0] ?? "" }

    private let now: () -> Date
    private let pauseThreshold: TimeInterval
    /// Arrival time of the most recent caption of any kind.
    private var lastCaptionAt: Date?
    /// A silence was observed; the next final starts a paragraph.
    private var pendingBreak = false

    /// `now` is injectable so pause detection is testable.
    public init(now: @escaping () -> Date = Date.init,
                pauseThreshold: TimeInterval = livePauseThreshold) {
        self.now = now
        self.pauseThreshold = pauseThreshold
    }

    /// Fold a relay message into the transcript/state.
    public func apply(_ message: ServerMessage) {
        switch message {
        case .ready:
            state = .listening
        case .caption(let text, let isFinal, let channel):
            noteCaptionArrival()
            let key = channel ?? 0
            if isFinal {
                if !text.isEmpty {
                    append(text, channel: channel,
                           startingParagraph: pendingBreak, to: &paragraphs)
                    pendingBreak = false
                }
                partials[key] = ""
            } else {
                partials[key] = text
            }
        case .error(let message):
            state = .error(message)
        }
    }

    /// A caption arriving after a silence means speech resumed. The relay only
    /// forwards captions with text, so any message at all is evidence someone is
    /// talking — and a long enough gap between them is evidence nobody was.
    /// Recorded rather than applied, because it is the partial reopening speech
    /// that sees the gap, and the final it belongs to arrives later.
    private func noteCaptionArrival() {
        let arrival = now()
        defer { lastCaptionAt = arrival }
        guard let last = lastCaptionAt else { return }
        if arrival.timeIntervalSince(last) >= pauseThreshold { pendingBreak = true }
    }

    /// Put a previous session's transcript ahead of this one's captions, so a
    /// resumed conversation reads as one. Safe either side of the first live
    /// caption: the restore and the session race, and neither order should lose.
    public func prepend(_ segments: [TranscriptSegment]) {
        let restored = buildParagraphs(from: segments)
        guard !restored.isEmpty else { return }
        let hadCaptions = !paragraphs.isEmpty
        paragraphs.insert(contentsOf: restored, at: 0)
        // With nothing live yet, the next final would run on from the restored
        // tail; a session boundary is a long pause by definition. If captions
        // are already here they are a separate paragraph and need no help —
        // and forcing a break would split a sentence mid-flow.
        if !hadCaptions { pendingBreak = true }
    }

    /// Clear the transcript and return to connecting (called at session start).
    public func reset() {
        paragraphs = []
        partials = [:]
        state = .connecting
        lastCaptionAt = nil
        pendingBreak = false
    }

    /// Force an error state (e.g. connection lost, permission denied).
    public func setError(_ message: String) {
        state = .error(message)
    }
}
```

- [ ] **Step 5: Run the `CaptionCore` suite to verify it passes**

```bash
cd watch/CaptionCore && swift test
```

Expected: PASS. `SessionControllerTests.testCaptionUpdatesStore` still references `store.lines` and will fail to compile — fix it now:

```swift
    func testCaptionUpdatesStore() async {
        let (c, store, relay, _) = make()
        await c.start()
        relay.deliver(.ready)
        relay.deliver(.caption(text: "hi", isFinal: true, channel: nil))
        XCTAssertEqual(store.paragraphs.map(\.text), ["hi"])
    }
```

Re-run until green.

- [ ] **Step 6: Adapt both apps mechanically**

In `mac/MacCaptions/CaptionPanel.swift:127-129`, the mac panel deliberately renders one continuous blob. Keep that behaviour — join the paragraphs back:

```swift
    // The panel is a single flowing line of text by design, so paragraph
    // breaks are joined away here rather than shown.
    private var finals: String {
        store.paragraphs.map(\.text).joined(separator: " ")
    }
```

In `watch/WatchCaptions/Views/CaptionView.swift`, the smallest change that compiles — paragraph polish is Task 5:

```swift
                    ForEach(store.paragraphs) { paragraph in
                        Text(paragraph.text).font(.system(size: 16))
                    }
```

and line 22:

```swift
            .onChange(of: store.paragraphs.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
```

- [ ] **Step 7: Build both apps**

```bash
cd watch && xcodegen generate && xcodebuild build -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)' 2>&1 | tail -5
```

```bash
cd mac && xcodegen generate && xcodebuild build -project Captions.xcodeproj -scheme Captions 2>&1 | tail -5
```

Expected: `BUILD SUCCEEDED` for both. The watch build needs `watch/WatchCaptions/Secrets.swift`; if it is missing, `cp watch/WatchCaptions/Secrets.example.swift watch/WatchCaptions/Secrets.swift` — it is gitignored and the placeholder values compile fine.

- [ ] **Step 8: Commit**

```bash
git add watch/CaptionCore/Sources/CaptionCore/CaptionStore.swift \
        watch/CaptionCore/Tests/CaptionCoreTests/CaptionStoreTests.swift \
        watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift \
        watch/WatchCaptions/Views/CaptionView.swift \
        mac/MacCaptions/CaptionPanel.swift
git commit -m "feat(watch): flow captions into paragraphs, breaking on silence"
```

---

### Task 4: Restore the previous transcript when a session resumes

**Files:**
- Modify: `watch/CaptionCore/Sources/CaptionCore/SessionController.swift`
- Modify: `watch/WatchCaptions/AppModel.swift:36-44`
- Test: `watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift`

**Interfaces:**
- Consumes: `CaptionStore.prepend(_:)` from Task 3; `HistoryClient` (existing, `History.swift:132`) with `detail(name:) async throws -> TranscriptDetail`.
- Produces: `SessionController.init(store:relay:audio:permission:history:)` with `history: HistoryClient? = nil`; internal `waitForPrefill() async` for tests.

- [ ] **Step 1: Write the failing tests**

In `SessionControllerTests.swift`, add a fake history client inside the test class, next to `FakeRelay`:

```swift
    struct FakeHistory: HistoryClient {
        var segments: [TranscriptSegment] = []
        var error: Error?

        func list() async throws -> [TranscriptListItem] { [] }
        func detail(name: String) async throws -> TranscriptDetail {
            if let error { throw error }
            return TranscriptDetail(name: name, summary: nil, segments: segments)
        }
        func delete(name: String) async throws {}
    }
```

Change the `make` helper to accept one:

```swift
    private func make(granted: Bool = true, history: HistoryClient? = nil)
        -> (SessionController, CaptionStore, FakeRelay, FakeAudio) {
        let store = CaptionStore()
        let relay = FakeRelay()
        let audio = FakeAudio()
        let c = SessionController(store: store, relay: relay, audio: audio,
                                  permission: FakePermission(granted: granted),
                                  history: history)
        return (c, store, relay, audio)
    }
```

And add these tests:

```swift
    private static let earlier = [
        TranscriptSegment(text: "earlier talk", channel: nil, at: "2026-07-10T18:00:00Z"),
    ]

    func testResumingRestoresThePreviousTranscript() async {
        let (controller, store, _, _) = make(history: FakeHistory(segments: Self.earlier))

        await controller.start(resuming: "2026-07-10T18-00-00Z_abc")
        await controller.waitForPrefill()

        XCTAssertEqual(store.paragraphs.map(\.text), ["earlier talk"])
    }

    func testANewSessionRestoresNothing() async {
        let (controller, store, _, _) = make(history: FakeHistory(segments: Self.earlier))

        await controller.start()
        await controller.waitForPrefill()

        XCTAssertTrue(store.paragraphs.isEmpty)
    }

    /// The session is the point. Missing scrollback is not worth an error over a
    /// working session.
    func testAFailedRestoreLeavesTheSessionRunning() async {
        let failing = FakeHistory(error: HistoryError.message("offline"))
        let (controller, store, relay, audio) = make(history: failing)

        await controller.start(resuming: "2026-07-10T18-00-00Z_abc")
        await controller.waitForPrefill()
        relay.deliver(.ready)

        XCTAssertTrue(store.paragraphs.isEmpty)
        XCTAssertEqual(store.state, .listening)
        XCTAssertTrue(audio.started)
    }

    func testASessionStoppedDuringTheRestoreIsNotPrefilled() async {
        let (controller, store, _, _) = make(history: FakeHistory(segments: Self.earlier))

        await controller.start(resuming: "2026-07-10T18-00-00Z_abc")
        controller.stop()
        await controller.waitForPrefill()

        XCTAssertTrue(store.paragraphs.isEmpty)
    }

    func testResumingWithoutAHistoryClientStillRuns() async {
        let (controller, store, relay, _) = make()

        await controller.start(resuming: "2026-07-10T18-00-00Z_abc")
        await controller.waitForPrefill()

        XCTAssertEqual(relay.resumedName, "2026-07-10T18-00-00Z_abc")
        XCTAssertTrue(store.paragraphs.isEmpty)
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd watch/CaptionCore && swift test --filter SessionControllerTests
```

Expected: FAIL to compile — `SessionController.init` has no `history:` parameter and no `waitForPrefill`.

- [ ] **Step 3: Add the restore to `SessionController`**

In `SessionController.swift`, add the stored properties after `permission`:

```swift
    private let history: HistoryClient?
    /// Retained so tests can await the restore. The app never waits on it.
    private var prefillTask: Task<Void, Never>?
```

Widen the initializer:

```swift
    public init(store: CaptionStore, relay: Relay,
                audio: AudioCapturing, permission: MicPermissionProviding,
                history: HistoryClient? = nil) {
        self.store = store
        self.relay = relay
        self.audio = audio
        self.permission = permission
        self.history = history
        self.relay.onMessage = { [weak self] message in self?.handle(message) }
        self.relay.onClose = { [weak self] in self?.handleClose() }
    }
```

In `start(resuming:)`, clear any previous task alongside the reset and kick off the restore after connecting:

```swift
    public func start(resuming name: String? = nil) async {
        guard !running else { return }
        running = true
        store.reset()
        prefillTask = nil
        guard await permission.ensureGranted() else {
            store.setError("Microphone access is off. Enable it in Settings › Privacy.")
            running = false
            return
        }
        guard running else { return }   // stopped during the await
        relay.connect(resuming: name)
        if let name { restorePreviousTranscript(named: name) }
    }
```

Cancel it in `stop()`:

```swift
    public func stop() {
        guard running else { return }
        running = false
        prefillTask?.cancel()
        audio.stop()
        relay.close()
    }
```

And add the restore itself, plus the test hook, at the end of the class:

```swift
    /// Put the transcript being resumed back in the scroll, so a conversation
    /// you glanced away from reads continuously.
    ///
    /// Deliberately not awaited: the captions screen appears at once and the
    /// history fills in behind it. A failure is dropped — an error banner over a
    /// working session would be worse than missing scrollback.
    private func restorePreviousTranscript(named name: String) {
        guard let history else { return }
        prefillTask = Task { [weak self] in
            guard let segments = try? await history.detail(name: name).segments else { return }
            guard let self, self.running else { return }
            self.store.prepend(segments)
        }
    }

    /// Awaits the restore started by `start(resuming:)`. Tests only.
    func waitForPrefill() async {
        await prefillTask?.value
    }
```

- [ ] **Step 4: Run the whole suite to verify it passes**

```bash
cd watch/CaptionCore && swift test
```

Expected: PASS, everything.

- [ ] **Step 5: Wire the history client through `AppModel`**

In `watch/WatchCaptions/AppModel.swift`, the init currently builds a `RelayHistoryClient` inline for `HistoryStore` only. Share one:

```swift
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let base = Self.httpBase(from: Secrets.relayURL)
        let historyClient = RelayHistoryClient(base: base, token: Secrets.authToken)
        relay = HTTPRelayClient(base: base, token: Secrets.authToken)
        history = HistoryStore(client: historyClient)
        controller = SessionController(
            store: store,
            relay: relay,
            audio: AudioCapture(),
            permission: MicPermission(),
            // Resuming a session restores its transcript; this reads it. Kept
            // off HistoryStore, whose `detail` belongs to the history screen.
            history: historyClient
        )
        lastSession = Self.loadLastSession(from: defaults)
        relay.onTranscript = { [weak self] name in self?.currentTranscript = name }
    }
```

- [ ] **Step 6: Build the watch app**

```bash
cd watch && xcodegen generate && xcodebuild build -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)' 2>&1 | tail -5
```

Expected: `BUILD SUCCEEDED`.

- [ ] **Step 7: Commit**

```bash
git add watch/CaptionCore/Sources/CaptionCore/SessionController.swift \
        watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift \
        watch/WatchCaptions/AppModel.swift
git commit -m "feat(watch): restore the resumed transcript into the caption scroll"
```

---

### Task 5: The live partial continues the current paragraph

Currently the in-progress partial takes a line of its own, which reintroduces the break Task 3 removed. It should flow inline, dimmed.

**Files:**
- Modify: `watch/WatchCaptions/Views/CaptionView.swift`

**Interfaces:**
- Consumes: `CaptionStore.paragraphs`, `CaptionStore.partial` from Task 3.
- Produces: nothing other tasks use.

- [ ] **Step 1: Rewrite the view**

This is SwiftUI in an app target with no unit tests, so there is no test cycle here — verification is the build plus the device pass in Task 7. Replace the body of `watch/WatchCaptions/Views/CaptionView.swift`:

```swift
import SwiftUI
import CaptionCore

struct CaptionView: View {
    @ObservedObject var store: CaptionStore
    let onStop: () -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(store.paragraphs.enumerated()), id: \.element.id) { index, paragraph in
                        text(for: paragraph, isLast: index == store.paragraphs.count - 1)
                            .font(.system(size: 16))
                    }
                    // Nothing final yet: the partial is all there is to show.
                    if store.paragraphs.isEmpty, !store.partial.isEmpty {
                        Text(store.partial).font(.system(size: 16)).foregroundStyle(.secondary)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: store.paragraphs.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: store.paragraphs.last?.text) { _, _ in scrollToBottom(proxy) }
            .onChange(of: store.partial) { _, _ in scrollToBottom(proxy) }
            .overlay(alignment: .topTrailing) {
                Circle().fill(.green).frame(width: 7, height: 7)
            }
            .toolbar {
                // Lowering your wrist no longer ends the session, so ending it
                // needs somewhere to live.
                // Trailing, so it does not take the back chevron's slot.
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: onStop) {
                        Label("Stop", systemImage: "stop.fill")
                    }
                }
            }
        }
    }

    /// The in-progress partial continues the paragraph it belongs to rather than
    /// taking a line of its own — otherwise every utterance still breaks.
    private func text(for paragraph: CaptionParagraph, isLast: Bool) -> Text {
        guard isLast, !store.partial.isEmpty else { return Text(paragraph.text) }
        return Text(paragraph.text) + Text(" " + store.partial).foregroundStyle(.secondary)
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        proxy.scrollTo("bottom", anchor: .bottom)
    }
}
```

`Text.foregroundStyle(_:)` returns `Text` on watchOS 10+, so the `+` concatenation is valid. If the compiler rejects it, use `.foregroundColor(.secondary)`, which also returns `Text`.

- [ ] **Step 2: Build the watch app**

```bash
cd watch && xcodebuild build -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)' 2>&1 | tail -5
```

Expected: `BUILD SUCCEEDED`.

- [ ] **Step 3: Commit**

```bash
git add watch/WatchCaptions/Views/CaptionView.swift
git commit -m "feat(watch): flow the in-progress caption into its paragraph"
```

---

### Task 6: Stored transcripts read as paragraphs too

The detail screen has the same one-`Text`-per-segment problem, and the shared builder is already there.

**Files:**
- Modify: `watch/WatchCaptions/Views/TranscriptDetailView.swift:31-69`

**Interfaces:**
- Consumes: `buildParagraphs(from:)` and `CaptionParagraph` from Task 2.
- Produces: nothing other tasks use.

- [ ] **Step 1: Render paragraphs instead of segments**

In `content(for:)`, replace the transcript block (currently lines 49-56):

```swift
                if !detail.segments.isEmpty {
                    Text("Transcript")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.secondary)
                    ForEach(buildParagraphs(from: detail.segments)) { paragraph in
                        Text(label(for: paragraph)).font(.system(size: 14))
                    }
                }
```

And replace `label(for:)` (currently lines 62-69):

```swift
    /// Mirrors how the relay labels dual-channel captures. A change of channel
    /// always starts a new paragraph, so one label per paragraph is right.
    private func label(for paragraph: CaptionParagraph) -> String {
        switch paragraph.channel {
        case 0: return "Me: \(paragraph.text)"
        case 1: return "Them: \(paragraph.text)"
        default: return paragraph.text
        }
    }
```

- [ ] **Step 2: Build the watch app**

```bash
cd watch && xcodebuild build -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)' 2>&1 | tail -5
```

Expected: `BUILD SUCCEEDED`.

- [ ] **Step 3: Commit**

```bash
git add watch/WatchCaptions/Views/TranscriptDetailView.swift
git commit -m "feat(watch): read stored transcripts as paragraphs"
```

---

### Task 7: Verify on hardware and document

Pause detection depends on real speech timing and the relay's poll cadence, neither of which the simulator reproduces. The paragraph behaviour has to be seen on a watch.

**Files:**
- Modify: `watch/README.md:40-45` (the "Run on your Watch" steps)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Run the full test suite and build both apps**

```bash
cd watch/CaptionCore && swift test 2>&1 | tail -5
```

```bash
cd watch && xcodebuild build -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)' 2>&1 | tail -3
cd ../mac && xcodegen generate && xcodebuild build -project Captions.xcodeproj -scheme Captions 2>&1 | tail -3
```

Expected: all tests pass, both builds succeed. Record the actual output — do not claim success without it.

- [ ] **Step 2: Verify on the watch by hand**

Open `watch/WatchCaptions.xcodeproj`, select the paired Apple Watch, run. Then check each of:

1. **Paragraph flow** — speak three or four sentences without pausing. They form one wrapping paragraph, not one line per sentence.
2. **Pause break** — speak, stop for about five seconds, speak again. A new paragraph starts at the resumption.
3. **Inline partial** — mid-sentence, the dimmed in-progress text sits at the end of the current paragraph, not on its own line.
4. **Resume restores** — speak a few sentences, leave the app (lower your wrist or swipe back), reopen within ten minutes. The earlier transcript is above the live captions, and new speech starts a fresh paragraph rather than running on from it.
5. **Continue from history** — Browse → a transcript → "Continue this session". Same restore behaviour.
6. **New session is clean** — from the menu, start a new session. The scroll is empty.
7. **Stored transcript** — Browse → a transcript. Its captions read as paragraphs.

- [ ] **Step 3: Update the README**

In `watch/README.md`, the "Run on your Watch (manual)" step 3 currently reads:

> 3. Speak (or have someone speak) — captions appear live (partial dimmed → final). The green dot means it's streaming. Lower your wrist / leave the app to stop.

Replace it with:

```markdown
3. Speak (or have someone speak) — captions appear live, flowing as a paragraph with the
   dimmed in-progress text at the end. A pause of a few seconds starts a new paragraph.
   The green dot means it's streaming. Lower your wrist / leave the app to stop.
4. Reopen within ten minutes: the session resumes and its transcript so far is restored
   above the live captions.
```

Renumber the steps that follow if there are any.

- [ ] **Step 4: Commit**

```bash
git add watch/README.md
git commit -m "docs(watch): describe paragraph captions and resume restore"
```

---

## Notes for the implementer

- **Do not reintroduce `CaptionLine`.** `paragraphs` replaces it outright; the mac app joins paragraphs back into one blob at the view layer, which is its existing behaviour.
- **Do not await the restore fetch in `start`.** The captions screen must appear immediately; the ordering is handled by `prepend` working from either side.
- **`prepend` sets `pendingBreak` only when nothing is live yet.** Setting it unconditionally splits a sentence when the fetch lands mid-speech — that is what `testPrependArrivingAfterLiveCaptionsDoesNotBreakTheLiveParagraph` guards.
- **The relay filters empty captions** (`backend/src/captionSession.ts:19`), which is what makes "a caption arrived" a usable proxy for "someone is speaking". If that filter ever goes away, live pause detection breaks.
