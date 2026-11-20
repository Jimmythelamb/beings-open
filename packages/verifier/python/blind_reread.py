#!/usr/bin/env python3
"""Blind re-read helper for the B.E.I.N.G.S. verifier (layout v3). Python + OpenCV + numpy.

Two independent steps, deliberately run as separate processes so the reader can only ever see the masked image:

  mask   --image scan.jpg --layout ballot-layout.json --out masked.png [--keep-ids]
         Finds the four registration marks (the top-left one is the largest), deskews the page into the layout frame
         (10 px per mm) and paints EVERYTHING black except the oval regions (optionally also the faint choice ids).
         The QR code, the ballot code text, the headings, the examples panel, the registration marks themselves,
         the receipt/tear area and everything below tearLineY are black in the result. The QR code is never decoded.

  read   --masked masked.png --layout ballot-layout.json
         The default OpenCV reader. Uses the same scoring as scanner/prototype/omr.py (ink = darker than half the
         paper level, fill = inner 0.8-scale ellipse ink ratio minus the baseline ring ink ratio, score 0..100) but
         measures the paper level from the kept baseline rings, because the margins are black in a masked image.
         Prints {"fillScores": {q: {choice: score}}, "paperLevel": n} as JSON. It reads no other file than the PNG.

  audit  --masked masked.png --layout ballot-layout.json
         Counts non-black pixels outside the kept regions (must be 0). Used by the tests.
"""
import argparse, json, sys
import cv2
import numpy as np

PX_PER_MM = 10.0   # same scale as scanner/prototype/omr.py
PAD_MM = 12.0
PAD_BOTTOM_MM = 58.0
KEEP_SCALE = 1.7   # the kept region around an oval: ellipse at 1.7x (the baseline ring ends at 1.6x)


def frame_meta(layout):
    fw, fh = layout["frame"]["widthMm"], layout["frame"]["heightMm"]
    return {"pxPerMm": PX_PER_MM, "padMm": PAD_MM,
            "widthPx": int((fw + 2 * PAD_MM) * PX_PER_MM), "heightPx": int((fh + PAD_MM + PAD_BOTTOM_MM) * PX_PER_MM)}


def find_markers(gray):
    """Return ({TL,TR,BL,BR: (x,y)} centres in image pixels, {name: size px}). Same detector as omr.py."""
    h, w = gray.shape
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    _, bw = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    n, lab, stats, cent = cv2.connectedComponentsWithStats(bw, 8)
    px_mm = w / 215.9  # the scan is the whole Letter page; only used to size-filter blobs
    cands = []
    for i in range(1, n):
        x, y, bw_, bh, area = stats[i]
        if bw_ < 6 * px_mm or bw_ > 13 * px_mm or bh < 6 * px_mm or bh > 13 * px_mm:
            continue
        if abs(bw_ - bh) > 0.2 * max(bw_, bh):
            continue
        if area < 0.85 * bw_ * bh:
            continue
        cands.append({"c": cent[i], "size": (bw_ + bh) / 2})
    if len(cands) < 4:
        raise RuntimeError(f"found {len(cands)} registration mark candidates, need 4")
    corners = {"TL": (0, 0), "TR": (w, 0), "BL": (0, h), "BR": (w, h)}
    out = {k: min(cands, key=lambda c: (c["c"][0] - cx) ** 2 + (c["c"][1] - cy) ** 2) for k, (cx, cy) in corners.items()}
    if len({tuple(v["c"]) for v in out.values()}) < 4:
        raise RuntimeError("could not assign four distinct registration marks")
    sizes = {k: v["size"] for k, v in out.items()}
    if sizes["TL"] <= max(sizes["TR"], sizes["BL"], sizes["BR"]) * 1.05:
        raise RuntimeError("the top-left registration mark is not the largest: page rotated or a mark is missing")
    return {k: (float(v["c"][0]), float(v["c"][1])) for k, v in out.items()}, sizes


def check_layout(layout):
    if layout.get("layoutVersion") != 3:
        raise RuntimeError(f"unsupported layout version {layout.get('layoutVersion')} (need 3)")
    for k in ("frame", "markers", "oval", "questions", "tearLineY", "qr", "ballotCodeText"):
        if k not in layout:
            raise RuntimeError(f"layout is missing {k}")
    if len(layout["markers"]) != 4:
        raise RuntimeError("layout must list four registration marks")


def keep_regions(layout, keep_ids=False):
    """The only places the masked image may show: list of ('ellipse', cx, cy, rx, ry) / ('rect', x, y, w, h) in
    layout mm. Refuses any region that touches a forbidden area (QR, ballot code, headings, receipt, below the tear)."""
    ov = layout["oval"]
    regs, forbid = [], []
    forbid.append(("qr", layout["qr"]["bbox"]))
    forbid.append(("ballot code", layout["ballotCodeText"]["bbox"]))
    if "receiptStub" in layout:
        forbid.append(("receipt", layout["receiptStub"]))
    if "examplesPanel" in layout:
        forbid.append(("examples panel", layout["examplesPanel"]))
    for m in layout["markers"]:
        s = m["sizeMm"] / 2
        forbid.append((f"marker {m['id']}", {"x": m["center"]["x"] - s, "y": m["center"]["y"] - s, "width": 2 * s, "height": 2 * s}))
    for q in layout["questions"]:
        if "headingBox" in q:
            forbid.append((f"heading {q['id']}", q["headingBox"]))
        for o in q["ovals"]:
            rx, ry = o["widthMm"] / 2 * KEEP_SCALE, o["heightMm"] / 2 * KEEP_SCALE
            regs.append(("ellipse", o["center"]["x"], o["center"]["y"], rx, ry, f"{q['id']}/{o['choiceId']}"))
            if keep_ids and "idBox" in o:
                b = o["idBox"]
                regs.append(("rect", b["x"], b["y"], b["width"], b["height"], f"{q['id']}/{o['choiceId']}#id"))
    tear = layout["tearLineY"]
    for r in regs:
        if r[0] == "ellipse":
            x0, y0, x1, y1 = r[1] - r[3], r[2] - r[4], r[1] + r[3], r[2] + r[4]
        else:
            x0, y0, x1, y1 = r[1], r[2], r[1] + r[3], r[2] + r[4]
        if y1 > tear:
            raise RuntimeError(f"region {r[5]} reaches below tearLineY")
        for name, b in forbid:
            if x0 < b["x"] + b["width"] and x1 > b["x"] and y0 < b["y"] + b["height"] and y1 > b["y"]:
                raise RuntimeError(f"region {r[5]} overlaps the {name}")
    return regs


def region_mask(shape, regs):
    m = np.zeros(shape, np.uint8)
    for r in regs:
        if r[0] == "ellipse":
            cv2.ellipse(m, (int(round((r[1] + PAD_MM) * PX_PER_MM)), int(round((r[2] + PAD_MM) * PX_PER_MM))),
                        (int(round(r[3] * PX_PER_MM)), int(round(r[4] * PX_PER_MM))), 0, 0, 360, 255, -1)
        else:
            x0, y0 = int(round((r[1] + PAD_MM) * PX_PER_MM)), int(round((r[2] + PAD_MM) * PX_PER_MM))
            cv2.rectangle(m, (x0, y0), (x0 + int(round(r[3] * PX_PER_MM)), y0 + int(round(r[4] * PX_PER_MM))), 255, -1)
    return m


def cmd_mask(a):
    layout = json.load(open(a.layout)); check_layout(layout)
    img = cv2.imread(a.image, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("cannot decode the image (only PNG/JPEG scans are supported)")
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    marks, sizes = find_markers(gray)
    fw, fh = layout["frame"]["widthMm"], layout["frame"]["heightMm"]
    src = np.float32([marks["TL"], marks["TR"], marks["BL"], marks["BR"]])
    dst = np.float32([[PAD_MM, PAD_MM], [PAD_MM + fw, PAD_MM], [PAD_MM, PAD_MM + fh], [PAD_MM + fw, PAD_MM + fh]]) * PX_PER_MM
    M = cv2.getPerspectiveTransform(src, dst)
    meta = frame_meta(layout)
    warped = cv2.warpPerspective(img, M, (meta["widthPx"], meta["heightPx"]), flags=cv2.INTER_CUBIC, borderValue=(255, 255, 255))
    regs = keep_regions(layout, a.keep_ids)
    mask = region_mask(warped.shape[:2], regs)
    masked = np.zeros_like(warped)
    masked[mask > 0] = warped[mask > 0]
    # stored as greyscale PNG: the ballot is read as ink on paper, colour carries nothing the reader uses
    cv2.imwrite(a.out, cv2.cvtColor(masked, cv2.COLOR_BGR2GRAY))
    print(json.dumps({**meta, "keptRegions": len(regs), "markerSizesPx": {k: round(v, 1) for k, v in sizes.items()},
                      "keepIds": bool(a.keep_ids)}))


def read_scores(wgray, layout, rules):
    """The OpenCV reader. `wgray` is the masked page (layout frame, PX_PER_MM, PAD_MM)."""
    ov = layout["oval"]; ss = ov["sampleScale"]; r0, r1 = ov["baselineRingScale"]

    def ell(cx, cy, rx, ry):
        m = np.zeros(wgray.shape, np.uint8)
        cv2.ellipse(m, (int(round(cx)), int(round(cy))), (int(round(rx)), int(round(ry))), 0, 0, 360, 1, -1)
        return m

    geo = []
    ring_all = np.zeros(wgray.shape, np.uint8)
    for q in layout["questions"]:
        for o in q["ovals"]:
            cx, cy = (o["center"]["x"] + PAD_MM) * PX_PER_MM, (o["center"]["y"] + PAD_MM) * PX_PER_MM
            rx, ry = o["widthMm"] / 2 * PX_PER_MM, o["heightMm"] / 2 * PX_PER_MM
            ring = (ell(cx, cy, rx * r1, ry * r1) - ell(cx, cy, rx * r0, ry * r0)) > 0
            inner = ell(cx, cy, rx * ss, ry * ss) > 0
            ring_all |= ring.astype(np.uint8)
            geo.append((q["id"], o["choiceId"], inner, ring))
    # paper level = median grey of the kept baseline rings (empty paper around each oval; the margins are black here)
    paper = float(np.median(wgray[ring_all > 0]))
    if paper < 100:
        raise RuntimeError(f"paper level {paper:.0f} is too dark: the masked image does not look like a ballot")
    ink = (wgray < paper * 0.5).astype(np.uint8)
    scores = {}
    for qid, cid, inner, ring in geo:
        fill = max(0.0, float(ink[inner].mean()) - float(ink[ring].mean()))
        scores.setdefault(qid, {})[cid] = int(round(fill * 100))
    return scores, paper


def cmd_read(a):
    layout = json.load(open(a.layout)); check_layout(layout)
    g = cv2.imread(a.masked, cv2.IMREAD_GRAYSCALE)
    meta = frame_meta(layout)
    if g is None or g.shape != (meta["heightPx"], meta["widthPx"]):
        raise RuntimeError("the masked image has the wrong size for this layout")
    scores, paper = read_scores(g, layout, None)
    print(json.dumps({"fillScores": scores, "paperLevel": paper}))


def cmd_audit(a):
    layout = json.load(open(a.layout)); check_layout(layout)
    g = cv2.imread(a.masked, cv2.IMREAD_GRAYSCALE)
    mask = region_mask(g.shape, keep_regions(layout, a.keep_ids))
    outside = int(np.count_nonzero((g > 0) & (mask == 0)))
    print(json.dumps({"nonBlackOutside": outside, "nonBlackInside": int(np.count_nonzero((g > 0) & (mask > 0)))}))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("mask"); m.add_argument("--image", required=True); m.add_argument("--layout", required=True); m.add_argument("--out", required=True); m.add_argument("--keep-ids", action="store_true")
    r = sub.add_parser("read"); r.add_argument("--masked", required=True); r.add_argument("--layout", required=True)
    u = sub.add_parser("audit"); u.add_argument("--masked", required=True); u.add_argument("--layout", required=True); u.add_argument("--keep-ids", action="store_true")
    a = ap.parse_args()
    try:
        {"mask": cmd_mask, "read": cmd_read, "audit": cmd_audit}[a.cmd](a)
    except Exception as e:  # one-line failure for the caller
        print(json.dumps({"error": str(e)}))
        sys.exit(3)


if __name__ == "__main__":
    main()
