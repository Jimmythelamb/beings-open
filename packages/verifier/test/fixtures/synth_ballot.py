#!/usr/bin/env python3
"""Draws a synthetic scan of a layout-v3 ballot for the blind re-read tests (no real voter data).

  synth_ballot.py --layout ballot-layout.json --out scan.png --fill '{"q1/c1":1.0,"q2/c3":0.35}' [--angle 1.2] [--blank]

Ovals listed in --fill are darkened from the left by that fraction (1.0 = fully filled). Besides the ovals the page
carries a noisy QR block, ballot code text, headings, choice ids, four registration marks (the top-left one larger)
and a receipt below the tear line, all of which the masking must remove."""
import argparse, json
import cv2
import numpy as np

S = 6.0            # px per mm of the synthetic scan
OX, OY = 10.0, 12.0  # page position (mm) of the top-left mark centre


def P(x, y):
    return (int(round((x + OX) * S)), int(round((y + OY) * S)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--layout", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--fill", default="{}"); ap.add_argument("--angle", type=float, default=1.2); ap.add_argument("--blank", action="store_true")
    a = ap.parse_args()
    L = json.load(open(a.layout)); fill = json.loads(a.fill)
    W, H = int(215.9 * S), int(279.4 * S)
    img = np.full((H, W), 255, np.uint8)
    if not a.blank:
        for m in L["markers"]:
            h = m["sizeMm"] / 2
            cv2.rectangle(img, P(m["center"]["x"] - h, m["center"]["y"] - h), P(m["center"]["x"] + h, m["center"]["y"] + h), 0, -1)
        rng = np.random.default_rng(7)
        q = L["qr"]["bbox"]; n = L["qr"]["modules"]; mod = q["width"] / n
        for i in range(n):
            for j in range(n):
                if rng.random() < 0.5:
                    cv2.rectangle(img, P(q["x"] + i * mod, q["y"] + j * mod), P(q["x"] + (i + 1) * mod, q["y"] + (j + 1) * mod), 0, -1)
        b = L["ballotCodeText"]["bbox"]
        cv2.putText(img, "ABCD-EFGH-1234", P(b["x"], b["y"] + b["height"]), cv2.FONT_HERSHEY_SIMPLEX, 1.6, 0, 3)
        cv2.putText(img, "Room 12 Class Election", P(40, -4), cv2.FONT_HERSHEY_SIMPLEX, 1.4, 0, 3)
        cv2.putText(img, "Fill in the oval completely. Do not write anything.", P(*(L["examplesPanel"]["x"], L["examplesPanel"]["y"] + 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.9, 0, 2)
        for qq in L["questions"]:
            h = qq["headingBox"]
            cv2.putText(img, f"{qq['id']} question heading text", P(h["x"], h["y"] + h["height"]), cv2.FONT_HERSHEY_SIMPLEX, 1.1, 0, 2)
            for o in qq["ovals"]:
                cx, cy = o["center"]["x"], o["center"]["y"]
                c = P(cx, cy); ax = (int(round(o["widthMm"] / 2 * S)), int(round(o["heightMm"] / 2 * S)))
                cv2.ellipse(img, c, ax, 0, 0, 360, 190, 2)
                f = fill.get(f"{qq['id']}/{o['choiceId']}", 0)
                if f > 0:
                    m = np.zeros_like(img)
                    cv2.ellipse(m, c, (int(ax[0] * 0.92), int(ax[1] * 0.92)), 0, 0, 360, 255, -1)
                    x_cut = c[0] - ax[0] + int(round(2 * ax[0] * f))
                    m[:, x_cut:] = 0
                    img[m > 0] = 0
                bx = o["idBox"]
                cv2.putText(img, o["choiceId"], P(bx["x"], bx["y"] + bx["height"]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, 120, 1)
        t = L["tearLineY"]
        for x in range(10, 180, 6):
            cv2.line(img, P(x, t), P(x + 3, t), 0, 2)
        cv2.putText(img, "RECEIPT ABCD-EFGH-1234", P(10, t + 12), cv2.FONT_HERSHEY_SIMPLEX, 1.4, 0, 3)
        cv2.rectangle(img, P(10, t + 20), P(120, t + 26), 0, -1)
    # rotate about the page centre and add a small shift, so the deskew has real work to do
    M = cv2.getRotationMatrix2D((W / 2, H / 2), a.angle, 1.0); M[0, 2] += 9; M[1, 2] -= 6
    out = cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_CUBIC, borderValue=255)
    cv2.imwrite(a.out, out)


if __name__ == "__main__":
    main()
