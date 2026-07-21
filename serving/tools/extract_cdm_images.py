"""Extract the unique drawings from a .cdm project file as PNGs.

Writes <layer>_fNNN_<imageDataId>.png per unique non-blank drawing (NNN =
first frame using it) — the corpus layout serving/onnx/parity_corpus.py
consumes. Color-layer URIs are lazily loaded by the app, so a .cdm may carry
fewer color images than color frames; blanks (fully transparent) are skipped.

    python tools/extract_cdm_images.py app/src/assets/cdm/robot.cdm /tmp/robot_corpus
"""
import base64
import io
import json
import os
import sys

import numpy as np
from PIL import Image


def main():
    cdm_path, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    raw = open(cdm_path).read()
    state = json.loads(raw.split("BEGINSAVESTATE")[1].split("BEGINTEMPIMAGES")[0])
    records = state["ImageStore"]["imageDataById"]

    for lname, layer in state["layers"].items():
        seen = set()
        kept = 0
        for nr, frame in enumerate(layer["frames"]):
            iid = frame and frame.get("imageDataId")
            if not iid or iid in seen:
                continue
            seen.add(iid)
            rec = records.get(iid)
            if not rec or not rec.get("dataUri"):
                continue  # lazily-unloaded image: not in the save file
            png = base64.b64decode(rec["dataUri"].split(",", 1)[1])
            im = Image.open(io.BytesIO(png)).convert("RGBA")
            if not (np.asarray(im)[..., 3] > 0).any():
                continue  # blank placeholder frame
            im.save(os.path.join(out_dir, f"{lname}_f{nr:03d}_{iid}.png"))
            kept += 1
        print(f"{lname}: {kept} drawings from {len(seen)} unique ids")


if __name__ == "__main__":
    main()
