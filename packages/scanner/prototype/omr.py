#!/usr/bin/env python3
"""Prototype OMR for B.E.I.N.G.S. ballots (layout v3). NOT the production scanner (M3 is a phone app).

  python3 omr.py --image scan-1.png --layout ballot-layout.json --ballot-list ballot-list.json \
                 --election election-file.json --out result.json --debug debug.png

Steps: find the 4 registration marks (TL is the biggest), warp the page to the layout frame, decode the
machine-read QR (BEINGS1|<electionCode>|<ballotCode>|L<layoutVersion>), check the code is on the ballot list,
measure each oval's fill ratio, and derive the per-question result with the same rules as @beings/core (spec 7.2).
A receipt QR (an https check-page link, election code only, below the tear line) is not that code and is ignored.
The final results string is built and validated by omr_finish.mjs with @beings/core itself.
"""
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import cv2
import numpy as np
from qr_select import choose_scan_payload

PX_PER_MM = 10.0   # warped image scale
PAD_MM = 12.0      # extra paper kept around the frame in the warped image (so marker squares are whole)
PAD_BOTTOM_MM = 58.0
GREEN, GREY, ORANGE = (0, 170, 0), (150, 150, 150), (0, 140, 255)


def find_markers(gray, dpi_guess):
    """Return {TL,TR,BL,BR: (x,y)} marker centres in image pixels."""
    h, w = gray.shape
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    _, bw = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    n, lab, stats, cent = cv2.connectedComponentsWithStats(bw, 8)
    px_mm = w / 215.9  # assumes the scan is the full Letter page; only used to size-filter blobs
    cands = []
    for i in range(1, n):
        x, y, bw_, bh, area = stats[i]
        if bw_ < 6 * px_mm or bw_ > 13 * px_mm or bh < 6 * px_mm or bh > 13 * px_mm:
            continue
        if abs(bw_ - bh) > 0.2 * max(bw_, bh):
            continue
        if area < 0.85 * bw_ * bh:  # solid squares only (QR finder patterns, text, the scissors do not pass)
            continue
        cands.append({"c": cent[i], "size": (bw_ + bh) / 2, "box": (x, y, bw_, bh)})
    if len(cands) < 4:
        raise RuntimeError(f"found {len(cands)} marker candidates, need 4")
    corners = {"TL": (0, 0), "TR": (w, 0), "BL": (0, h), "BR": (w, h)}
    out = {}
    for name, (cx, cy) in corners.items():
        best = min(cands, key=lambda c: (c["c"][0] - cx) ** 2 + (c["c"][1] - cy) ** 2)
        out[name] = best
    if len({tuple(v["c"]) for v in out.values()}) < 4:
        raise RuntimeError("could not assign four distinct markers")
    sizes = {k: v["size"] for k, v in out.items()}
    if sizes["TL"] <= max(sizes["TR"], sizes["BL"], sizes["BR"]) * 1.05:
        raise RuntimeError(f"TL marker is not the largest {sizes}: page rotated or marker missing")
    return {k: (float(v["c"][0]), float(v["c"][1])) for k, v in out.items()}, sizes


def _qr_texts(det, im):
    """Every string a detector reports for this image. Empty or failed reads are dropped."""
    found = []
    if im is None or getattr(im, "size", 0) == 0:
        return found
    multi = getattr(det, "detectAndDecodeMulti", None)
    if multi is not None:
        try:
            ok, infos, _pts, _straight = multi(im)
        except cv2.error:
            ok, infos = False, None
        if ok and infos is not None:
            found.extend(t for t in infos if t)
    try:
        txt, _pts, _ = det.detectAndDecode(im)
    except cv2.error:
        txt = ""
    if txt:
        found.append(txt)
    return found


def decode_qr(img_bgr, warped_bgr, layout):
    """Decode the machine-read QR (BEINGS1|...).

    The layout crop is tried first, so a receipt link elsewhere on the page cannot win.
    Receipt links (https URLs) are ignored wherever they are found. The receipt QR is not
    in layout['qr']; that box is only the scan symbol.
    """
    det = cv2.QRCodeDetector()
    q = layout["qr"]["bbox"]
    x0 = int((q["x"] + PAD_MM - 4) * PX_PER_MM); y0 = int((q["y"] + PAD_MM - 4) * PX_PER_MM)
    x1 = int((q["x"] + q["width"] + PAD_MM + 4) * PX_PER_MM); y1 = int((q["y"] + q["height"] + PAD_MM + 4) * PX_PER_MM)
    crop = warped_bgr[y0:y1, x0:x1]
    # Machine-read region first. A receipt QR below the tear must not be the one we keep.
    for scale in (1.0, 2.0, 3.0):
        im = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        chosen = choose_scan_payload(_qr_texts(det, im))
        if chosen:
            return chosen, f"qr-crop@{scale}"
    for name, im0 in (("warped", warped_bgr), ("original", img_bgr)):
        for scale in (1.0, 2.0, 0.5):
            im = im0 if scale == 1 else cv2.resize(im0, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            chosen = choose_scan_payload(_qr_texts(det, im))
            if chosen:
                return chosen, f"{name}@{scale}"
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--layout", required=True)
    ap.add_argument("--ballot-list", required=True)
    ap.add_argument("--election", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--debug", required=True)
    a = ap.parse_args()

    layout = json.load(open(a.layout)); blist = json.load(open(a.ballot_list)); election = json.load(open(a.election))
    rules = election.get("resultRules", {"emptyBelow": 15, "markedAbove": 50})
    img = cv2.imread(a.image, cv2.IMREAD_COLOR)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    marks, sizes = find_markers(gray, None)

    fw, fh = layout["frame"]["widthMm"], layout["frame"]["heightMm"]
    src = np.float32([marks["TL"], marks["TR"], marks["BL"], marks["BR"]])
    dst = np.float32([[PAD_MM, PAD_MM], [PAD_MM + fw, PAD_MM], [PAD_MM, PAD_MM + fh], [PAD_MM + fw, PAD_MM + fh]]) * PX_PER_MM
    M = cv2.getPerspectiveTransform(src, dst)
    W = int((fw + 2 * PAD_MM) * PX_PER_MM); H = int((fh + PAD_MM + PAD_BOTTOM_MM) * PX_PER_MM)
    warped = cv2.warpPerspective(img, M, (W, H), flags=cv2.INTER_CUBIC, borderValue=(255, 255, 255))
    wgray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)

    # marker alignment check: the warped marker centres must sit on the layout's marker centres
    # (the warp is built from them, so measure instead the blob centre of each marker in the warped image)
    align = {}
    for m in layout["markers"]:
        cx, cy = (m["center"]["x"] + PAD_MM) * PX_PER_MM, (m["center"]["y"] + PAD_MM) * PX_PER_MM
        r = int((m["sizeMm"] / 2 + 2) * PX_PER_MM)
        roi = wgray[int(cy - r):int(cy + r), int(cx - r):int(cx + r)]
        _, b = cv2.threshold(roi, 128, 255, cv2.THRESH_BINARY_INV)
        mm = cv2.moments(b, True)
        if mm["m00"] > 0:
            align[m["id"]] = round(float(np.hypot(mm["m10"] / mm["m00"] - r, mm["m01"] / mm["m00"] - r) / PX_PER_MM), 2)

    # QR / ballot code
    payload, how = decode_qr(img, warped, layout)
    qr = {"payload": payload, "decodedFrom": how}
    problems = []
    ballot_code = None
    if payload is None:
        problems.append("QR code could not be decoded")
    else:
        parts = payload.split("|")
        if len(parts) != 4 or parts[0] != "BEINGS1":
            problems.append(f"unexpected QR payload format")
        else:
            _, ecode, ballot_code, lay = parts
            if ecode != layout["electionCode"]:
                problems.append(f"QR election code {ecode} != {layout['electionCode']}")
            if lay != f"L{layout['layoutVersion']}":
                problems.append(f"QR layout {lay} != L{layout['layoutVersion']}")
            qr.update(electionCode=ecode, ballotCode=ballot_code, layoutTag=lay)
    on_list = None
    if ballot_code:
        on_list = any(b["ballotCode"] == ballot_code for b in blist["ballots"])
        if not on_list:
            problems.append("ballot code is NOT in ballot-list.json")
    qr["onBallotList"] = on_list

    # paper level from the empty paper just left of the question column
    paper = float(np.median(wgray[int(PAD_MM * PX_PER_MM): int((PAD_MM + 214) * PX_PER_MM), int(2 * PX_PER_MM): int(8 * PX_PER_MM)]))
    ink_thr = paper * 0.5  # a pixel counts as ink when it is darker than half the paper level
    ink = (wgray < ink_thr).astype(np.uint8)

    def ellipse_mask(cx, cy, rx, ry, rx_in=0.0):
        m = np.zeros(wgray.shape, np.uint8)
        cv2.ellipse(m, (int(round(cx)), int(round(cy))), (int(round(rx)), int(round(ry))), 0, 0, 360, 1, -1)
        if rx_in > 0:
            cv2.ellipse(m, (int(round(cx)), int(round(cy))), (int(round(rx * rx_in)), int(round(ry * rx_in))), 0, 0, 360, 0, -1)
        return m

    ov = layout["oval"]; ss = ov["sampleScale"]; r0, r1 = ov["baselineRingScale"]
    scores = {}; detail = {}
    dbg = warped.copy()
    for q in layout["questions"]:
        scores[q["id"]] = {}; detail[q["id"]] = {}
        for o in q["ovals"]:
            cx, cy = (o["center"]["x"] + PAD_MM) * PX_PER_MM, (o["center"]["y"] + PAD_MM) * PX_PER_MM
            rx, ry = o["widthMm"] / 2 * PX_PER_MM, o["heightMm"] / 2 * PX_PER_MM
            inner = ellipse_mask(cx, cy, rx * ss, ry * ss)
            ring = ellipse_mask(cx, cy, rx * r1, ry * r1) - ellipse_mask(cx, cy, rx * r0, ry * r0)
            fill_raw = float(ink[inner > 0].mean())
            base = float(ink[ring > 0].mean())
            fill = max(0.0, fill_raw - base)
            score = int(round(fill * 100))
            state = "marked" if score > rules["markedAbove"] else ("empty" if score < rules["emptyBelow"] else "unclear")
            scores[q["id"]][o["choiceId"]] = score
            detail[q["id"]][o["choiceId"]] = {"fillRatioRaw": round(fill_raw, 4), "baselineRing": round(base, 4), "score": score, "state": state,
                                               "meanGrayInside": round(float(wgray[inner > 0].mean()), 1)}
            col = {"marked": GREEN, "empty": GREY, "unclear": ORANGE}[state]
            cv2.ellipse(dbg, (int(round(cx)), int(round(cy))), (int(round(rx * 1.2)), int(round(ry * 1.2))), 0, 0, 360, col, 4)
            cv2.putText(dbg, f"{o['choiceId']}: {score}% {state}", (int((PAD_MM + 128) * PX_PER_MM), int(cy + 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.85, col if state != "empty" else (110, 110, 110), 2, cv2.LINE_AA)
    # frame, markers, QR box
    for m in layout["markers"]:
        cv2.circle(dbg, (int((m["center"]["x"] + PAD_MM) * PX_PER_MM), int((m["center"]["y"] + PAD_MM) * PX_PER_MM)), 6, (255, 0, 255), -1)
    qb = layout["qr"]["bbox"]
    cv2.rectangle(dbg, (int((qb["x"] + PAD_MM) * PX_PER_MM), int((qb["y"] + PAD_MM) * PX_PER_MM)), (int((qb["x"] + qb["width"] + PAD_MM) * PX_PER_MM), int((qb["y"] + qb["height"] + PAD_MM) * PX_PER_MM)), (255, 120, 0), 2)
    ty = int((layout["tearLineY"] + PAD_MM) * PX_PER_MM)
    segs = []
    for q in layout["questions"]:
        sc = scores[q["id"]]
        st = {c: ("marked" if v > rules["markedAbove"] else "empty" if v < rules["emptyBelow"] else "unclear") for c, v in sc.items()}
        mk = [c for c, v in st.items() if v == "marked"]
        segs.append("O" if len(mk) > q["maxMarks"] else "U" if "unclear" in st.values() else "B" if not mk else "V:" + "+".join(mk))
    cv2.putText(dbg, "green = marked   grey = empty   orange = unclear", (20, H - 60), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 2, cv2.LINE_AA)
    cv2.putText(dbg, f"ballot {ballot_code}   results {'|'.join(segs)}", (20, H - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 2, cv2.LINE_AA)
    cv2.imwrite(a.debug, dbg)

    # per-question results with the core rules (re-implemented here for the debug view; omr_finish.mjs recomputes with @beings/core)
    out = {
        "image": a.image,
        "markerCentresPx": marks, "markerSizesPx": {k: round(v, 1) for k, v in sizes.items()},
        "warpMarkerOffsetMm": align,
        "paperLevel": paper, "inkThreshold": ink_thr,
        "qr": qr, "problems": problems,
        "fillScores": scores, "detail": detail,
        "resultRules": rules,
    }
    json.dump(out, open(a.out, "w"), indent=2)
    print(json.dumps({"ballotCode": ballot_code, "onList": on_list, "problems": problems, "scores": scores}))


if __name__ == "__main__":
    main()
