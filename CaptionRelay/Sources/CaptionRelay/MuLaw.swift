import Foundation

/// Decodes G.711 μ-law, the format telephony audio arrives in.
///
/// Mirrors the relay's encoder exactly. The two must agree sample for sample:
/// a mismatched table is not a decode failure, it is a call that sounds wrong.
public enum MuLaw {
    private static let bias: Int32 = 0x84

    public static func decode(_ data: Data) -> [Int16] {
        data.map { byte in
            let u = Int32(~byte)
            let sign = u & 0x80
            let exponent = (u >> 4) & 0x07
            let mantissa = u & 0x0F
            let magnitude = (((mantissa << 3) + bias) << exponent) - bias
            return Int16(clamping: sign != 0 ? -magnitude : magnitude)
        }
    }
}
