from pathlib import Path
from PIL import Image

source = Path('/home/ubuntu/webdev-static-assets/pricecheck-pwa-icon.png')
target = Path('/home/ubuntu/pricecheck-web/public/icons')
target.mkdir(parents=True, exist_ok=True)

with Image.open(source) as image:
    square = image.convert('RGBA')
    for size in (192, 512):
        resized = square.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(target / f'icon-{size}.png', optimize=True)
