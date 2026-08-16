import XCTest
@testable import CaptionRelay

final class SummaryMarkdownTests: XCTestCase {
    func testStripsBulletSyntaxFromRenderedText() {
        let rendered = String("- first\n- second".asSummaryMarkdown.characters)
        XCTAssertFalse(rendered.contains("- "), "bullet syntax should not survive into the rendered text")
        XCTAssertTrue(rendered.contains("first"))
    }

    func testKeepsHeadingTextWithoutHashes() {
        let rendered = String("## Feature freeze".asSummaryMarkdown.characters)
        XCTAssertFalse(rendered.contains("#"))
        XCTAssertTrue(rendered.contains("Feature freeze"))
    }

    func testFallsBackToPlainTextOnUnparseableInput() {
        let rendered = String("plain text".asSummaryMarkdown.characters)
        XCTAssertEqual(rendered, "plain text")
    }

    /// `.inlineOnlyPreservingWhitespace` alone does not touch block syntax:
    /// bullets pass through as literal `- ` unless stripped by hand first.
    /// This guards the preprocessing step that makes `testStripsBulletSyntaxFromRenderedText` pass.
    func testBulletBecomesADotNotJustDisappearing() {
        let rendered = String("- first\n- second".asSummaryMarkdown.characters)
        XCTAssertTrue(rendered.contains("• first"),
                       "bullet marker should become a plain dot, not just vanish")
        XCTAssertTrue(rendered.contains("• second"),
                       "both bullet lines should survive, not just the first")
    }

    /// The whole point of preprocessing instead of `.full` markdown parsing:
    /// multi-section summaries must keep their line breaks so paragraphs,
    /// headings, and bullets don't run together on a 40mm screen.
    func testPreservesLineBreaksAcrossParagraphsHeadingsAndBullets() {
        let input = "Overview line.\n\n## Section\n\n- first\n- second"
        let rendered = String(input.asSummaryMarkdown.characters)
        XCTAssertTrue(rendered.contains("Overview line.\n"))
        XCTAssertTrue(rendered.contains("Section\n"))
        XCTAssertTrue(rendered.contains("first\n"))
        XCTAssertFalse(rendered.contains("##"))
    }
}
