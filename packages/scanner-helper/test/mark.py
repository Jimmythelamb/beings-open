# Test helper: fill ovals on a rendered sample ballot. usage: mark.py <png> <layout.json> q1/c1 [q1/c2 ...]
import json, sys, os
sys.dont_write_bytecode = True  # keep the repo clean
import cv2
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../scanner/prototype"))
from omr import find_markers

png, layout_path, *marks = sys.argv[1:]
layout = json.load(open(layout_path))
img = cv2.imread(png, cv2.IMREAD_COLOR)
m, _ = find_markers(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), None)
tlx, tly = m["TL"]; trx, _ = m["TR"]
px_mm = (trx - tlx) / layout["frame"]["widthMm"]
for spec in marks:
    q, c = spec.split("/")
    ov = next(o for qq in layout["questions"] if qq["id"] == q for o in qq["ovals"] if o["choiceId"] == c)
    cx = int(tlx + ov["center"]["x"] * px_mm); cy = int(tly + ov["center"]["y"] * px_mm)
    cv2.ellipse(img, (cx, cy), (int(ov["widthMm"] / 2 * px_mm * 0.9), int(ov["heightMm"] / 2 * px_mm * 0.9)), 0, 0, 360, (20, 20, 20), -1)
cv2.imwrite(png, img)
