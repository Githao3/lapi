import glob
import os

MAP = [
    ("text-red-400/80", "text-rose-600"),
    ("bg-cyan-950/40", "bg-indigo-50"),
    ("bg-amber-950/40", "bg-amber-50"),
    ("hover:text-cyan-400", "hover:text-indigo-500"),
    ("hover:border-cyan-700", "hover:border-indigo-400"),
    ("hover:text-cyan-300", "hover:text-indigo-600"),
    ("hover:border-emerald-700", "hover:border-emerald-400"),
    ("border-neutral-800", "border-zinc-200"),
    ("border-neutral-700", "border-zinc-300"),
    ("border-neutral-900", "border-zinc-200"),
    ("bg-neutral-950", "bg-white"),
    ("bg-neutral-900", "bg-zinc-50"),
    ("bg-neutral-800", "bg-zinc-100"),
    ("text-neutral-100", "text-zinc-900"),
    ("text-neutral-200", "text-zinc-800"),
    ("text-neutral-300", "text-zinc-700"),
    ("text-neutral-400", "text-zinc-500"),
    ("text-neutral-500", "text-zinc-500"),
    ("text-neutral-600", "text-zinc-400"),
    ("border-emerald-900", "border-emerald-200"),
    ("border-emerald-700", "border-emerald-300"),
    ("bg-emerald-950", "bg-emerald-50"),
    ("text-emerald-200", "text-emerald-700"),
    ("text-emerald-300", "text-emerald-700"),
    ("text-emerald-400", "text-emerald-600"),
    ("text-emerald-500", "text-emerald-600"),
    ("border-red-900", "border-rose-200"),
    ("bg-red-950", "bg-rose-50"),
    ("text-red-300", "text-rose-700"),
    ("text-red-400", "text-rose-600"),
    ("bg-red-600", "bg-rose-600"),
    ("text-cyan-200", "text-indigo-800"),
    ("text-cyan-300", "text-indigo-700"),
    ("text-cyan-400", "text-indigo-600"),
    ("text-cyan-500", "text-indigo-600"),
    ("border-cyan-900", "border-indigo-200"),
    ("text-amber-200", "text-amber-800"),
    ("text-amber-400", "text-amber-700"),
    ("border-amber-900", "border-amber-200"),
]

for path in glob.glob(r"D:\Attempt\Zcode\local-api\web\src\pages\*.tsx"):
    text = open(path, "r", encoding="utf-8", newline="").read()
    total = 0
    for old, new in MAP:
        n = text.count(old)
        if n:
            text = text.replace(old, new)
            total += n
    open(path, "w", encoding="utf-8", newline="").write(text)
    print(os.path.basename(path), "replacements:", total)
