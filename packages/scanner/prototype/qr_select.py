"""Choose the machine-read ballot QR and ignore the receipt link.

The scanner reads one payload:

    BEINGS1|<electionCode>|<ballotCode>|L<layoutVersion>

The receipt QR is a different code. It is an https URL whose fragment is the
election code only (`#e=BEINGS-YYYY-XXXXXX`). It is printed below the tear
line, at a module size whose finder pattern is smaller than a registration
mark. This module is the rule that keeps the two apart: a receipt URL is
never returned as the scan, even when a detector reports it first.
"""

SCAN_PREFIX = "BEINGS1"
# find_markers in omr.py keeps solid squares from 6 mm to 13 mm.
# A QR finder pattern is 7 modules across, so a receipt module must stay under 6/7 mm.
MIN_MARKER_MM = 6.0


def finder_mm(module_mm):
    return 7.0 * float(module_mm)


def receipt_module_is_safe(module_mm):
    return finder_mm(module_mm) < MIN_MARKER_MM


def is_scan_payload(text):
    """True only for the machine-read BEINGS1 payload. Receipt https links are false."""
    if not isinstance(text, str) or not text:
        return False
    if "://" in text or text.startswith("http"):
        return False
    parts = text.split("|")
    if len(parts) != 4 or parts[0] != SCAN_PREFIX:
        return False
    return parts[3].startswith("L") and parts[1].startswith("BEINGS-") and len(parts[2]) == 12


def choose_scan_payload(candidates):
    """First machine-read payload, or None. Receipt links and anything else are skipped."""
    chosen = None
    for text in candidates:
        if is_scan_payload(text) and chosen is None:
            chosen = text
    return chosen


def main(argv):
    if argv and argv[0] == "--finder-ok":
        return 0 if receipt_module_is_safe(argv[1]) else 1
    chosen = choose_scan_payload(argv)
    if chosen:
        print(chosen)
    return 0


if __name__ == "__main__":
    import sys
    raise SystemExit(main(sys.argv[1:]))
