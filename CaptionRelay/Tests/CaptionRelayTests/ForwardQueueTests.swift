import XCTest
@testable import CaptionRelay

final class ForwardQueueTests: XCTestCase {

    // MARK: - append / order

    func testAppendCreatesEntryAndPreservesLineOrder() {
        var queue = ForwardQueue()
        queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "one", isFinal: true))
        queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "two", isFinal: true))
        queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "three", isFinal: true))

        XCTAssertEqual(queue.entries.count, 1)
        let entry = queue.entries[0]
        XCTAssertEqual(entry.sessionId, "s1")
        XCTAssertEqual(entry.token, "tok1")
        XCTAssertEqual(entry.lines.map(\.text), ["one", "two", "three"])
        XCTAssertFalse(entry.finished)
    }

    func testAppendAcrossSessionsCreatesSeparateEntriesInOrder() {
        var queue = ForwardQueue()
        queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "a", isFinal: true))
        queue.append(sessionId: "s2", token: "tok2", caption: .init(text: "b", isFinal: true))
        queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "c", isFinal: true))

        XCTAssertEqual(queue.entries.count, 2)
        XCTAssertEqual(queue.entries[0].sessionId, "s1")
        XCTAssertEqual(queue.entries[0].lines.map(\.text), ["a", "c"])
        XCTAssertEqual(queue.entries[1].sessionId, "s2")
        XCTAssertEqual(queue.entries[1].lines.map(\.text), ["b"])
    }

    // MARK: - markFinished

    func testMarkFinishedSetsFlagOnMatchingEntry() {
        var queue = ForwardQueue()
        queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "a", isFinal: true))
        queue.markFinished(sessionId: "s1", token: "tok1")

        XCTAssertTrue(queue.entries[0].finished)
    }

    func testMarkFinishedWithNoPriorAppendCreatesEmptyFinishedEntry() {
        var queue = ForwardQueue()
        queue.markFinished(sessionId: "s1", token: "tok1")

        XCTAssertEqual(queue.entries.count, 1)
        XCTAssertTrue(queue.entries[0].finished)
        XCTAssertTrue(queue.entries[0].lines.isEmpty)
    }

    func testMarkFinishedDoesNotAffectOtherSessions() {
        var queue = ForwardQueue()
        queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "a", isFinal: true))
        queue.append(sessionId: "s2", token: "tok2", caption: .init(text: "b", isFinal: true))
        queue.markFinished(sessionId: "s1", token: "tok1")

        XCTAssertTrue(queue.entries.first { $0.sessionId == "s1" }!.finished)
        XCTAssertFalse(queue.entries.first { $0.sessionId == "s2" }!.finished)
    }

    // MARK: - nextDeliverable

    func testNextDeliverableNilWhenBelowThresholdAndNotFinished() {
        var queue = ForwardQueue()
        for i in 0..<5 {
            queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "\(i)", isFinal: true))
        }
        XCTAssertNil(queue.nextDeliverable(batchThreshold: 10))
    }

    func testNextDeliverableReturnsEntryAtOrAboveThreshold() {
        var queue = ForwardQueue()
        for i in 0..<10 {
            queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "\(i)", isFinal: true))
        }
        let next = queue.nextDeliverable(batchThreshold: 10)
        XCTAssertEqual(next?.sessionId, "s1")
        XCTAssertEqual(next?.lines.count, 10)
    }

    func testNextDeliverableReturnsFinishedEntryEvenBelowThreshold() {
        var queue = ForwardQueue()
        queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "only one line", isFinal: true))
        queue.markFinished(sessionId: "s1", token: "tok1")

        let next = queue.nextDeliverable(batchThreshold: 10)
        XCTAssertEqual(next?.sessionId, "s1")
        XCTAssertTrue(next?.finished ?? false)
    }

    func testNextDeliverablePrefersFinishedOverThresholdEntry() {
        var queue = ForwardQueue()
        // s1: below threshold, not finished — should not be picked.
        for i in 0..<3 {
            queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "\(i)", isFinal: true))
        }
        // s2: finished, tiny — should be preferred.
        queue.append(sessionId: "s2", token: "tok2", caption: .init(text: "x", isFinal: true))
        queue.markFinished(sessionId: "s2", token: "tok2")
        // s3: at threshold, not finished.
        for i in 0..<10 {
            queue.append(sessionId: "s3", token: "tok3", caption: .init(text: "\(i)", isFinal: true))
        }

        let next = queue.nextDeliverable(batchThreshold: 10)
        XCTAssertEqual(next?.sessionId, "s2", "finished entries must win over threshold entries")
    }

    func testNextDeliverableNilWhenQueueEmpty() {
        let queue = ForwardQueue()
        XCTAssertNil(queue.nextDeliverable(batchThreshold: 10))
    }

    // MARK: - delivered

    func testDeliveredRemovesExactlyDeliveredLinesAndKeepsEntryOpen() {
        var queue = ForwardQueue()
        for i in 0..<5 {
            queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "\(i)", isFinal: true))
        }
        queue.delivered(sessionId: "s1", lineCount: 3, finished: false)

        XCTAssertEqual(queue.entries.count, 1)
        XCTAssertEqual(queue.entries[0].lines.map(\.text), ["3", "4"])
        XCTAssertFalse(queue.entries[0].finished)
    }

    func testDeliveredDropsEntryOnceFinishedAndEmpty() {
        var queue = ForwardQueue()
        queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "a", isFinal: true))
        queue.markFinished(sessionId: "s1", token: "tok1")
        queue.delivered(sessionId: "s1", lineCount: 1, finished: true)

        XCTAssertTrue(queue.entries.isEmpty, "finished + empty entry (token included) must be dropped")
    }

    func testDeliveredKeepsFinishedEntryIfLinesRemain() {
        var queue = ForwardQueue()
        for i in 0..<3 {
            queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "\(i)", isFinal: true))
        }
        queue.markFinished(sessionId: "s1", token: "tok1")
        queue.delivered(sessionId: "s1", lineCount: 2, finished: true)

        XCTAssertEqual(queue.entries.count, 1)
        XCTAssertEqual(queue.entries[0].lines.map(\.text), ["2"])
        XCTAssertTrue(queue.entries[0].finished)
    }

    func testDeliveredWithFinishedFalseNeverDropsEvenIfLinesEmpty() {
        var queue = ForwardQueue()
        queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "a", isFinal: true))
        queue.delivered(sessionId: "s1", lineCount: 1, finished: false)

        XCTAssertEqual(queue.entries.count, 1, "not-finished entries survive even when empty")
        XCTAssertTrue(queue.entries[0].lines.isEmpty)
    }

    func testDeliveredOnUnknownSessionIsNoop() {
        var queue = ForwardQueue()
        queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "a", isFinal: true))
        queue.delivered(sessionId: "nope", lineCount: 1, finished: false)

        XCTAssertEqual(queue.entries.count, 1)
        XCTAssertEqual(queue.entries[0].lines.count, 1)
    }

    // MARK: - Codable round-trip

    func testCodableRoundTripByteStable() throws {
        var queue = ForwardQueue()
        queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "hello", isFinal: false))
        queue.append(sessionId: "s1", token: "tok1", caption: .init(text: "hello world", isFinal: true))
        queue.append(sessionId: "s2", token: "tok2", caption: .init(text: "second session", isFinal: true))
        queue.markFinished(sessionId: "s2", token: "tok2")

        // .sortedKeys: JSONEncoder's default key order is not guaranteed
        // stable across encodes of equal values (it is backed by a
        // hash-ordered dictionary on Apple platforms) — sorting keys is what
        // makes "byte-identical" a meaningful assertion here rather than a
        // flaky one.
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let data1 = try encoder.encode(queue)
        let decoded = try JSONDecoder().decode(ForwardQueue.self, from: data1)
        XCTAssertEqual(decoded, queue)

        let data2 = try encoder.encode(decoded)
        XCTAssertEqual(data1, data2, "re-encoding a round-tripped value must be byte-identical")
    }
}
