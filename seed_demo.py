"""Fill a throwaway data folder with sample deals so the site has something to show.

    DATA_DIR=demo-data .venv/bin/python seed_demo.py
    DATA_DIR=demo-data PORT=5061 .venv/bin/python app.py

Never point DATA_DIR at real data: this wipes the deals table first.
Photos are drawn placeholders, not real properties.
"""
import json
import os
import random
import sys
import time
import uuid

if not os.environ.get("DATA_DIR"):
    sys.exit("Set DATA_DIR to a demo folder, e.g. DATA_DIR=demo-data")
os.environ.pop("DATABASE_URL", None)

from PIL import Image, ImageDraw  # noqa: E402

import app  # noqa: E402  (creates tables and the first admin)

PALETTES = [
    ((176, 206, 230), (130, 82, 64), (58, 44, 40)),     # red brick
    ((214, 224, 236), (196, 186, 160), (92, 84, 70)),   # tan frame
    ((190, 214, 232), (94, 110, 128), (40, 48, 60)),    # grey siding
    ((236, 214, 190), (160, 104, 72), (70, 46, 36)),    # sunset brick
    ((200, 220, 210), (226, 222, 210), (80, 90, 96)),   # white frame
]


def draw_house(seed, flats=1):
    rnd = random.Random(seed)
    sky, wall, roof = rnd.choice(PALETTES)
    w, h = 1600, 1200
    img = Image.new("RGB", (w, h), sky)
    d = ImageDraw.Draw(img)
    for y in range(h):  # sky gradient
        t = y / h
        d.line([(0, y), (w, y)], fill=tuple(int(c * (1 - .25 * t)) for c in sky))
    d.rectangle([0, 900, w, h], fill=(110, 140, 96))
    d.rectangle([0, 960, w, 1010], fill=(170, 170, 166))
    bw = 760 if flats == 1 else 820
    x0, x1 = (w - bw) // 2, (w + bw) // 2
    top = 380 if flats == 1 else 240
    d.rectangle([x0, top, x1, 960], fill=wall)
    if flats == 1:
        d.polygon([(x0 - 50, top), (w // 2, top - 230), (x1 + 50, top)], fill=roof)
    else:
        d.rectangle([x0 - 20, top - 40, x1 + 20, top], fill=roof)
    floors = 1 if flats == 1 else flats
    fh = (960 - top) // (floors + (1 if flats == 1 else 0))
    for f in range(floors + (1 if flats == 1 else 0)):
        y = top + 40 + f * fh
        for i in range(3):
            wx = x0 + 90 + i * (bw - 180) // 2 - 55
            if f == floors - (0 if flats > 1 else -1) - 1 and i == 1 and flats == 1:
                continue
            d.rectangle([wx, y, wx + 110, y + min(150, fh - 70)], fill=(236, 240, 244), outline=roof, width=10)
    d.rectangle([w // 2 - 70, 760, w // 2 + 70, 960], fill=roof)
    d.rectangle([w // 2 - 120, 940, w // 2 + 120, 970], fill=(150, 150, 146))
    return img


def save(img):
    pid = uuid.uuid4().hex
    full = img.copy()
    full.save(app.photo_path(pid), "JPEG", quality=82)
    img.thumbnail((800, 800))
    img.save(app.photo_path(pid, True), "JPEG", quality=78)
    return pid


DEALS = [
    ("active", dict(address="2417 W 21st St", city="Chicago", zip="60608", area="Pilsen", county="Cook", type="2-flat",
                    beds=5, baths=2, sqft=2280, lot="25 x 125", year=1904, units=2, occupancy="Vacant",
                    price=239000, arv=465000, repairs=118000, rent=3100, emd=5000, closeBy="2026-11-20",
                    description="Classic brick 2-flat on a tree-lined block. Both units vacant and ready for a full gut. "
                                "Strong rental demand; renovated 2-flats on this block are trading $450–480k.",
                    highlights="Both units vacant\nNew roof 2022\nSeparate furnaces and meters\nOne block to the Pink Line"), 2),
    ("active", dict(address="8133 S Ellis Ave", city="Chicago", zip="60619", area="Chatham", county="Cook", type="Single family",
                    beds=3, baths=1.5, sqft=1320, lot="30 x 124", year=1926, units=1, occupancy="Vacant",
                    price=92000, arv=215000, repairs=58000, rent=1850, emd=2500, closeBy="2026-11-08",
                    description="Brick bungalow with full basement and detached garage. Needs kitchen, baths, mechanicals and cosmetics.",
                    highlights="Full basement\n2-car garage\nSolid brick, straight foundation"), 1),
    ("active", dict(address="1542 N Lawler Ave", city="Chicago", zip="60651", area="Austin", county="Cook", type="3-flat",
                    beds=6, baths=3, sqft=3300, lot="30 x 125", year=1912, units=3, occupancy="Partially occupied",
                    price=268000, arv=520000, repairs=135000, rent=3900, emd=5000, closeBy="2026-12-01",
                    description="Greystone 3-flat. Garden unit tenant on month-to-month at $1,150. Upper units vacant.",
                    highlights="Greystone facade\nOne tenant in place\nNew electric service 2021"), 3),
    ("active", dict(address="417 Kenilworth Ave", city="Glen Ellyn", zip="60137", area="", county="DuPage", type="Single family",
                    beds=4, baths=2, sqft=1980, lot="60 x 150", year=1958, units=1, occupancy="Vacant",
                    price=318000, arv=545000, repairs=95000, emd=10000, closeBy="2026-11-15",
                    description="Split-level in a top school district. Dated throughout; a cosmetic-plus rehab sells fast here.",
                    highlights="District 41 schools\nLarge lot\nAttached 2-car garage"), 1),
    ("pending", dict(address="5920 W Henderson St", city="Chicago", zip="60634", area="Portage Park", county="Cook", type="Single family",
                     beds=3, baths=2, sqft=1450, year=1922, units=1, occupancy="Vacant",
                     price=245000, arv=410000, repairs=72000), 1),
    ("pending", dict(address="1209 Cass Ave", city="Joliet", zip="60432", county="Will", type="4-unit",
                     beds=8, baths=4, sqft=3600, year=1950, units=4, occupancy="Tenant occupied",
                     price=210000, arv=360000, repairs=60000, rent=3800), 2),
    ("sold", dict(address="3314 W Beach Ave", city="Chicago", zip="60651", area="Humboldt Park", county="Cook", type="2-flat",
                  beds=4, baths=2, sqft=2100, year=1898, units=2, price=255000, arv=480000, repairs=110000), 2),
    ("closed", dict(address="7740 S Kingston Ave", city="Chicago", zip="60649", area="South Shore", county="Cook", type="Single family",
                    beds=3, baths=1, sqft=1200, year=1921, units=1, price=78000, arv=190000, repairs=52000), 1),
]


def main():
    d = app.DB()
    d.execute("DELETE FROM deals")
    now = app.now_ms()
    for i, (status, fields, flats) in enumerate(DEALS):
        body = {k: None for k in list(app.TEXT_FIELDS) + list(app.NUM_FIELDS)}
        body.update(fields)
        photos = [save(draw_house(f"{i}-{n}", flats)) for n in range(3 if status == "active" else 1)]
        t = now - i * 86400_000 * 2
        d.execute("INSERT INTO deals (id, status, data, photos, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                  (uuid.uuid4().hex[:10], status, json.dumps(body), json.dumps(photos), t, t))
    for k, v in {"phone": "(312) 555-0606", "email": "deals@example.com"}.items():
        d.execute("DELETE FROM settings WHERE key=?", (k,))
        d.execute("INSERT INTO settings (key, value) VALUES (?,?)", (k, v))
    d.commit()
    d.close()
    print(f"Seeded {len(DEALS)} demo deals into {app.DATA_DIR}")


if __name__ == "__main__":
    main()
