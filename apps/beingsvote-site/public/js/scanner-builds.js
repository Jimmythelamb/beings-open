// Approved scanner builds: the site's list of scanner-software fingerprints an organizer can approve for a new election.
// Plain data (tested). The create form puts every entry with `default: true` into the election file automatically, so
// organizers no longer type hashes. "Advanced: use a different scanner build" lets them pick or paste another one.
//
// Be honest about what each value is. A fingerprint only proves something if anyone can recompute it from the thing it
// names. `derivation` says exactly how the value was made; `kind` says whether it can be recomputed:
//   "agreed-label"  a fixed value agreed for tests. It does NOT come from hashing any software, so it identifies the
//                   station's setup by agreement only. Kept so new classroom elections match QB1TTH's scanner station.
//   "file-sha256"   SHA-256 of the raw bytes of one named file. Anyone can recompute it ("Check it yourself" on the
//                   admin and results pages accepts the file; tools/scanner-build/fingerprint.mjs does it on a computer).
//
// To add a real build: hash it with tools/scanner-build/fingerprint.mjs, add an entry with kind "file-sha256", and move
// `default: true` to it once the organizer agrees. Changing the default changes what NEW elections record; elections
// already on the ledger keep whatever they recorded.

export const SCANNER_BUILDS_SCHEMA = "beings-scanner-builds/1";

export const SCANNER_BUILDS = [
  {
    id: "classroom-station-label-2026-11",
    label: "Classroom scanner/printer station (Coston2 test label)",
    sha256: "06694fe1cdf4766e89d713efca9c78dcf82f413b8de2907fff946aa895695527",
    date: "2026-11-09",
    default: true,
    kind: "agreed-label",
    covers:
      "The local scanner/printer station used for the Coston2 classroom tests: a Brother scanner/printer read by packages/scanner-helper, which runs the mark reader packages/scanner/prototype/omr.py and omr_finish.mjs, with a signing wallet recording the readings. The value is a name for that setup, not a measurement of its software.",
    derivation:
      "Fixed test value chosen for the Coston2 classroom elections; the organizer handover notes (kept outside the repository) call it \"synthetic, not a real app build\", and the value registered for the QB1TTH scanner station. It is not the SHA-256 of any file in the repository at main fe2f8cb: every file was hashed and none matches.",
    usedIn: ["BEINGS-2026-QB1TTH"],
  },
  {
    id: "omr-py-prototype-receipt-link",
    label: "Mark reader prototype omr.py (ignores the receipt link)",
    sha256: "d30efb344142dc55948aa96c3a56677f924adae69436100642d4fa0b83aa1664",
    date: "2026-11-15",
    default: false,
    kind: "file-sha256",
    file: "packages/scanner/prototype/omr.py",
    covers:
      "Only the Python mark reader packages/scanner/prototype/omr.py. It reads the BEINGS1 code in the layout's QR box and ignores a receipt link. It does not cover qr_select.py, omr_finish.mjs, the scanner-helper, Python or OpenCV versions, the scanner's own firmware, or the signing wallet.",
    derivation:
      "SHA-256 of the raw bytes of packages/scanner/prototype/omr.py. The same file on main fe2f8cb hashed to 2eb3c5f323ad441a4a679196e3844e59695c9c48b97797f5fcc0f82b70966461, before the receipt link was ignored. This is the same formula the ledger test scripts use for the app fingerprint (packages/ledger/scripts/scanned-ballot.js and scanned-5.js: sha256Hex(readFileSync(omr.py))). Recompute: node apps/beingsvote-site/tools/scanner-build/fingerprint.mjs packages/scanner/prototype/omr.py",
    usedIn: [],
  },
  {
    id: "qr-select-receipt-link",
    label: "Receipt-link filter qr_select.py",
    sha256: "8be4f75df47919cecc65cb4264e8529b6662a1be8c972218c52df0a0902a31b9",
    date: "2026-11-15",
    default: false,
    kind: "file-sha256",
    file: "packages/scanner/prototype/qr_select.py",
    covers:
      "Only packages/scanner/prototype/qr_select.py, the rule that accepts a BEINGS1 scan payload and ignores an https receipt link. It does not cover omr.py or the printer.",
    derivation:
      "SHA-256 of the raw bytes of packages/scanner/prototype/qr_select.py. Recompute: node apps/beingsvote-site/tools/scanner-build/fingerprint.mjs packages/scanner/prototype/qr_select.py",
    usedIn: [],
  },
];
