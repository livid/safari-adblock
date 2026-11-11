// Checks a Sparkle EdDSA signature against a public key, independently of Sparkle's tools.
// The release script uses it to confirm that an update archive verifies against the
// SUPublicEDKey inside the app being shipped: a mismatch would break updates for everyone.
//
//   swift tools/verify-update-signature.swift <base64 public key> <file> <base64 signature>

import CryptoKit
import Foundation

let args = CommandLine.arguments
guard args.count == 4,
      let keyData = Data(base64Encoded: args[1]),
      let signature = Data(base64Encoded: args[3]),
      let file = FileManager.default.contents(atPath: args[2])
else {
  FileHandle.standardError.write("usage: verify-update-signature <public key> <file> <signature>\n".data(using: .utf8)!)
  exit(2)
}

do {
  let key = try Curve25519.Signing.PublicKey(rawRepresentation: keyData)
  if key.isValidSignature(signature, for: file) {
    print("signature OK")
  } else {
    print("signature does NOT match the public key")
    exit(1)
  }
} catch {
  print("bad public key: \(error)")
  exit(2)
}
