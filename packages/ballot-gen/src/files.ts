import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BeingsError } from "@beings/core";
import type { GeneratedElection } from "./generate.js";

export const OUTPUT_FILES = {
  pdf: "ballots.pdf",
  layout: "ballot-layout.json",
  electionFile: "election-file.json",
  ballotList: "ballot-list.json",
  manifest: "manifest.json",
} as const;

const pretty = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

export function manifestOf(g: GeneratedElection): Record<string, unknown> {
  return {
    tool: "@beings/ballot-gen",
    schemaVersion: "0.1",
    electionCode: g.electionFile.electionCode,
    ballots: g.ballotList.count,
    files: { ...OUTPUT_FILES },
    electionFileSha256: g.electionFileSha256,
    electionFileHashNote: "SHA-256 of the canonical JSON (RFC 8785) of election-file.json, not of its pretty-printed bytes",
    layoutHash: g.layoutHash,
    layoutSha256: g.layoutSha256,
    layoutHashNote: "SHA-256 of the canonical JSON of ballot-layout.json. The same value is the layoutHash field INSIDE election-file.json, so the election file hash that goes on-chain covers the layout. layoutSha256 is the older name of the same value.",
    ballotListRoot: g.ballotList.ballotListRoot,
    createElection: g.createElection,
    warnings: g.warnings,
  };
}

/** Writes the five output files. Refuses to overwrite existing ones unless `force`: a new run makes NEW codes. */
export function writeOutputs(g: GeneratedElection, outDir: string, force = false): string[] {
  const names = Object.values(OUTPUT_FILES);
  if (!force) {
    const clash = names.filter((n) => existsSync(join(outDir, n)));
    if (clash.length > 0) throw new BeingsError("BAD_INPUT", `${outDir} already has ${clash.join(", ")}; use --force to overwrite (this makes NEW ballot codes)`);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, OUTPUT_FILES.pdf), g.pdf);
  writeFileSync(join(outDir, OUTPUT_FILES.layout), pretty(g.layout));
  writeFileSync(join(outDir, OUTPUT_FILES.electionFile), pretty(g.electionFile));
  writeFileSync(join(outDir, OUTPUT_FILES.ballotList), pretty(g.ballotList));
  writeFileSync(join(outDir, OUTPUT_FILES.manifest), pretty(manifestOf(g)));
  return names.map((n) => join(outDir, n));
}
