import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, "gen2.py")).read()
exec(src[: src.index("xs = [")])
OUT = os.path.join(HERE, "final"); os.makedirs(OUT, exist_ok=True)
globals()["OUT"] = OUT
for lang in ("en", "es"):
    print(render(f"x-instawards-{lang}", x_keynote(X_THEMES["a-medianoche"], lang)))
    print(render(f"ig-meet-{lang}", ig_bento(IG_THEMES["a-claro"], lang)))
