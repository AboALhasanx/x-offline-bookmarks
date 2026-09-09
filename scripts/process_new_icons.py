"""Regenerate canonical Expo assets from the new artwork masters (2026-09-09).

Masters live in assets/masters/. Outputs (overwritten in place):
  assets/icon.png                        1024x1024 RGBA (direct copy)
  assets/splash-icon.png                 1024x1024 RGBA (direct copy)
  assets/android-icon-foreground.png     512x512  RGBA (art scaled into safe zone)
  assets/android-icon-monochrome.png     432x432  RGBA (art scaled into safe zone)
  assets/favicon.png                     48x48    RGBA (downscaled from new icon)
"""
import os
from PIL import Image

A = "assets"

SIZE_ICON = 1024
SIZE_FG = 512
SIZE_MONO = 432
SIZE_FAV = 48

# Android adaptive icon safe zone: inner 66dp circle of 108dp canvas -> 0.6111
SAFE_ZONE = 66.0 / 108.0


def trimmed_bbox(im: Image.Image) -> tuple[int, int, int, int]:
    """Crop box of non-transparent (alpha > 8) content, or full box for RGB art."""
    if "A" in im.getbands():
        alpha = im.split()[-1].point(lambda a: 255 if a > 8 else 0)
        bbox = alpha.getbbox()
        if bbox:
            return bbox
    return (0, 0, im.width, im.height)


def fit_into_safe_zone(im: Image.Image, out_size: int, scale: float = 0.92) -> Image.Image:
    """Return out_size x out_size RGBA with im's opaque content centered and scaled
    so it spans at most SAFE_ZONE * scale of the full canvas."""
    bbox = trimmed_bbox(im)
    art = im.crop(bbox)

    target = out_size * SAFE_ZONE * scale
    s = min(target / art.width, target / art.height)
    new_w = max(1, round(art.width * s))
    new_h = max(1, round(art.height * s))
    art = art.resize((new_w, new_h), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (out_size, out_size), (0, 0, 0, 0))
    canvas.alpha_composite(art, ((out_size - new_w) // 2, (out_size - new_h) // 2))
    return canvas


def main() -> None:
    icon_m = Image.open(f"{A}/masters/icon.png").convert("RGBA")
    splash_m = Image.open(f"{A}/masters/splash-icon.png").convert("RGBA")
    fg_m = Image.open(f"{A}/masters/android-icon-foreground.png").convert("RGBA")
    mono_m = Image.open(f"{A}/masters/android-icon-monochrome.png").convert("RGBA")

    # 1. icon.png - direct copy at 1024x1024 (already RGBA, correct size)
    icon_m.save(f"{A}/icon.png", "PNG")
    print(f"icon.png <- {icon_m.size} direct copy")

    # 2. splash-icon.png - direct copy at 1024x1024
    splash_m.save(f"{A}/splash-icon.png", "PNG")
    print(f"splash-icon.png <- {splash_m.size} direct copy")

    # 3. android-icon-foreground.png - 512x512, art in safe zone
    fg = fit_into_safe_zone(fg_m, SIZE_FG)
    fg.save(f"{A}/android-icon-foreground.png", "PNG")
    print(f"android-icon-foreground.png <- {SIZE_FG}x{SIZE_FG}, art fits safe zone")

    # 4. android-icon-monochrome.png - 432x432, art in safe zone
    mono = fit_into_safe_zone(mono_m, SIZE_MONO)
    mono.save(f"{A}/android-icon-monochrome.png", "PNG")
    print(f"android-icon-monochrome.png <- {SIZE_MONO}x{SIZE_MONO}, art fits safe zone")

    # 5. favicon.png - 48x48 from new icon
    fav = icon_m.resize((SIZE_FAV, SIZE_FAV), Image.Resampling.LANCZOS)
    fav.save(f"{A}/favicon.png", "PNG")
    print(f"favicon.png <- {SIZE_FAV}x{SIZE_FAV} from new icon")

    for f in ["icon.png", "splash-icon.png", "android-icon-foreground.png",
              "android-icon-monochrome.png", "favicon.png"]:
        p = os.path.join(A, f)
        with Image.open(p) as im:
            print(f"  {f:34s} {im.size[0]}x{im.size[1]} mode={im.mode} {os.path.getsize(p)//1024}KB")


if __name__ == "__main__":
    main()
