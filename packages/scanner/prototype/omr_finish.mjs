// Turns omr.py's fill scores into the results string with @beings/core and validates it. Usage:
//   node omr_finish.mjs <page.json> <election-file.json> <native-image-file> <out.json>
import fs from "node:fs";
import * as core from "@beings/core";

const [pageJson, electionFile, imageFile, outFile] = process.argv.slice(2);
const page = JSON.parse(fs.readFileSync(pageJson, "utf8"));
const election = JSON.parse(fs.readFileSync(electionFile, "utf8"));

const order = election.questions.map((q) => q.id);
const results = core.deriveResults(election, page.fillScores); // spec 7.2 rules, in core
const encoded = core.encodeResults(results, order);
const entry = { ballotCode: page.qr.ballotCode, results };
const problems = [...page.problems, ...core.entryProblems(entry, election)];
// the string must also round-trip through the strict parser
const decoded = core.decodeResults(encoded, order);
if (core.encodeResults(decoded, order) !== encoded) problems.push("results string does not round-trip");
const states = Object.fromEntries(Object.entries(page.fillScores).map(([q, cs]) => [q, Object.fromEntries(Object.entries(cs).map(([c, s]) => [c, core.bubbleState(s, election.resultRules)]))]));
const unclearOvals = Object.entries(states).flatMap(([q, cs]) => Object.entries(cs).filter(([, s]) => s === "unclear").map(([c]) => `${q}/${c}`));
// "low confidence": a score within 10 points of a threshold
const near = [];
for (const [q, cs] of Object.entries(page.fillScores)) for (const [c, s] of Object.entries(cs)) {
  if (Math.abs(s - election.resultRules.emptyBelow) <= 10 || Math.abs(s - election.resultRules.markedAbove) <= 10) near.push(`${q}/${c}=${s}`);
}
const imageBytes = fs.readFileSync(imageFile);
const out = {
  ballotCode: page.qr.ballotCode,
  onBallotList: page.qr.onBallotList,
  fillScores: page.fillScores,
  states,
  results,
  resultsString: encoded,
  resultsHash: core.resultsHash(results, order),
  coreValidationProblems: problems,
  unclearOvals,
  lowConfidenceOvals: near,
  imageFile,
  imageSha256: core.sha256Hex(imageBytes),
};
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ ballot: out.ballotCode, results: encoded, problems, unclearOvals, near, imageSha256: out.imageSha256 }));
