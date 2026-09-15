"""生成与 logo.svg 一致的抗锯齿 PNG，供 VS Code 扩展列表使用。"""
from pathlib import Path
from PIL import Image, ImageDraw

scale = 4
size = 256 * scale
image = Image.new('RGBA', (size, size))
mask = Image.new('L', (size, size))
ImageDraw.Draw(mask).rounded_rectangle((32, 32, 992, 992), radius=224, fill=255)
pixels = image.load()
for y in range(size):
    for x in range(size):
        ratio = (x + y) / (2 * size)
        pixels[x, y] = tuple(round(a + (b - a) * ratio) for a, b in zip((23, 50, 57), (16, 26, 37))) + (mask.getpixel((x, y)),)
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((34, 34, 990, 990), radius=222, outline='#33545a', width=4)
def stroke(points, color, width):
    coords = [(x * scale, y * scale) for x, y in points]
    draw.line(coords, fill=color, width=width * scale, joint='curve')
    radius = width * scale / 2
    for x, y in coords:
        draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=color)
stroke([(111,70), (57,128), (111,186)], '#78e1cc', 22)
for points in [[(141,86),(192,86)],[(128,128),(177,128)],[(141,170),(192,170)]]:
    stroke(points, '#dbf7ef', 16)
image.resize((256,256), Image.Resampling.LANCZOS).save(Path(__file__).resolve().parents[1] / 'media/logo.png')
