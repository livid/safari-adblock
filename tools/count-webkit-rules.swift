// Measures how many WebKit content-blocker rules Safari makes from each bundled ruleset, and
// writes extension/rules/webkit-rule-counts.json, which the background reads to size the
// downloaded lists under Safari's 150,000-rule limit. Run after tools/build-rules.mjs:
//
//   swift tools/count-webkit-rules.swift
//
// It uses WebKit's own declarativeNetRequest translator, a private class, so it's a
// development tool only. If it stops working, delete the counts file: the background then
// falls back to a generous estimate.

import Foundation
import ObjectiveC
import WebKit

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let extensionDir = root.appendingPathComponent("extension")

// Make WebKit's classes visible to the runtime, then find the translator.
_ = WKWebView.self
var classCount: UInt32 = 0
_ = objc_copyClassNamesForImage(class_getImageName(WKWebView.self)!, &classCount)
guard let translator = objc_getClass("_WKWebExtensionDeclarativeNetRequestTranslator") as? AnyClass else {
  FileHandle.standardError.write("WebKit's declarativeNetRequest translator isn't available on this macOS.\n".data(using: .utf8)!)
  exit(1)
}

typealias Call = @convention(c) (AnyObject, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSArray?>?) -> NSArray?
func call(_ name: String, _ arg: AnyObject) -> (NSArray, [String]) {
  let sel = NSSelectorFromString(name)
  let fn = unsafeBitCast(method_getImplementation(class_getClassMethod(translator, sel)!), to: Call.self)
  var errors: NSArray?
  let out = fn(object_getClass(translator)!, sel, arg, &errors) ?? []
  return (out, (errors as? [String]) ?? [])
}

let manifestData = try Data(contentsOf: extensionDir.appendingPathComponent("manifest.json"))
let manifest = try JSONSerialization.jsonObject(with: manifestData) as! [String: Any]
let resources = (manifest["declarative_net_request"] as! [String: Any])["rule_resources"] as! [[String: Any]]

var counts: [String: Int] = [:]
for resource in resources {
  let id = resource["id"] as! String
  let data = try Data(contentsOf: extensionDir.appendingPathComponent(resource["path"] as! String))
  let (objects, readErrors) = call("jsonObjectsFromData:errorStrings:", [id: data] as NSDictionary)
  let (rules, translateErrors) = call("translateRules:errorStrings:", objects)
  counts[id] = rules.count
  let errors = readErrors + translateErrors
  print("\(id): \(rules.count) WebKit rules\(errors.isEmpty ? "" : ", \(errors.count) rejected:")")
  for e in errors.prefix(10) { print("  \(e)") }
}

let total = counts.values.reduce(0, +)
print("total: \(total) of 150000, leaving \(150_000 - total) for downloaded lists")

let out = try JSONSerialization.data(withJSONObject: counts, options: [.sortedKeys, .prettyPrinted])
try (out + "\n".data(using: .utf8)!).write(to: extensionDir.appendingPathComponent("rules/webkit-rule-counts.json"))
