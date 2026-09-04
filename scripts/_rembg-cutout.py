# rembg AI 抠图：识别人物（银发保留——颜色抠图会把银发当背景抠掉）
from rembg import remove
from PIL import Image
import sys

src = sys.argv[1] if len(sys.argv) > 1 else "assets/mashiro-face-close.png"
dst = sys.argv[2] if len(sys.argv) > 2 else "assets/mashiro-icon.png"

img = Image.open(src).convert("RGBA")
out = remove(img)
out.save(dst)
print(f"AI 抠图完成: {src} -> {dst} ({out.size[0]}x{out.size[1]})")
