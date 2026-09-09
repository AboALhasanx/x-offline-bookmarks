import os
from PIL import Image, ImageDraw

SIZE_FULL = 1024
SIZE_ADAPTIVE = 512
SIZE_MONO = 432
SIZE_FAV = 48

# Color Palette: Premium X Midnight Black, subtle carbon layers, vibrant X blue, pure white
BG_BLACK = (0, 0, 0, 255)
BG_CARD = (22, 24, 28, 255)
ACCENT_BLUE = (29, 155, 240, 255)
WHITE = (255, 255, 255, 255)
BORDER_GRAY = (47, 51, 54, 255)

def draw_bookmark(draw, left, top, right, bottom, notch_depth, fill, outline=None, width=0):
    cx = (left + right) / 2
    points = [
        (left, top),
        (right, top),
        (right, bottom),
        (cx, bottom - notch_depth),
        (left, bottom),
    ]
    draw.polygon(points, fill=fill)
    if outline and width > 0:
        draw.line(points + [points[0]], fill=outline, width=width, joint="curve")

def draw_official_x_logo(draw, cx, cy, size, fill):
    """
    Renders the exact geometric proportions of the official Unicode mathematical bold capital X:
    Left top to right bottom: wide solid bar.
    Right top to left bottom: thinner bar crossing through.
    """
    half = size / 2.0
    
    # 1. Main thick diagonal (\)
    bar_w = size * 0.225
    poly1 = [
        (cx - half, cy - half),
        (cx - half + bar_w, cy - half),
        (cx + half, cy + half),
        (cx + half - bar_w, cy + half),
    ]
    draw.polygon(poly1, fill=fill)

    # 2. Crossing thin diagonal (/)
    bar_w2 = size * 0.125
    poly2 = [
        (cx + half, cy - half),
        (cx + half - bar_w2, cy - half),
        (cx - half, cy + half),
        (cx - half + bar_w2, cy + half),
    ]
    draw.polygon(poly2, fill=fill)

def generate_all():
    os.makedirs("assets", exist_ok=True)

    # -------------------------------------------------------------
    # 1. icon.png (1024x1024) - Clean rounded squircle icon
    # -------------------------------------------------------------
    icon = Image.new("RGBA", (SIZE_FULL, SIZE_FULL), (0, 0, 0, 0))
    d = ImageDraw.Draw(icon)
    
    # Rounded dark squircle
    radius = 224
    d.rounded_rectangle([0, 0, SIZE_FULL, SIZE_FULL], radius=radius, fill=BG_BLACK)
    d.rounded_rectangle([0, 0, SIZE_FULL, SIZE_FULL], radius=radius, outline=BORDER_GRAY, width=4)

    # Centered modern Bookmark
    bw = 460
    bh = 660
    bcx = SIZE_FULL / 2
    bcy = SIZE_FULL / 2 + 35
    notch = 130
    
    # Glow / shadow layer
    draw_bookmark(d, bcx - bw/2 - 8, bcy - bh/2 - 8, bcx + bw/2 + 8, bcy + bh/2 + 8, notch + 6, fill=(29, 155, 240, 50))
    # Bookmark plate
    draw_bookmark(d, bcx - bw/2, bcy - bh/2, bcx + bw/2, bcy + bh/2, notch, fill=BG_CARD, outline=ACCENT_BLUE, width=12)
    # X emblem in upper center of bookmark
    draw_official_x_logo(d, bcx, bcy - 75, 260, WHITE)

    icon.save("assets/icon.png", "PNG")
    print("Regenerated assets/icon.png")

    # -------------------------------------------------------------
    # 2. splash-icon.png (1024x1024)
    # -------------------------------------------------------------
    splash = Image.new("RGBA", (SIZE_FULL, SIZE_FULL), (0, 0, 0, 0))
    sd = ImageDraw.Draw(splash)
    sw = 400
    sh = 580
    scx = SIZE_FULL / 2
    scy = SIZE_FULL / 2
    snotch = 110
    draw_bookmark(sd, scx - sw/2, scy - sh/2, scx + sw/2, scy + sh/2, snotch, fill=BG_CARD, outline=ACCENT_BLUE, width=12)
    draw_official_x_logo(sd, scx, scy - 65, 230, WHITE)
    splash.save("assets/splash-icon.png", "PNG")
    print("Regenerated assets/splash-icon.png")

    # -------------------------------------------------------------
    # 3. android-icon-background.png (512x512) - Solid True Black
    # -------------------------------------------------------------
    bg = Image.new("RGBA", (SIZE_ADAPTIVE, SIZE_ADAPTIVE), BG_BLACK)
    bg.save("assets/android-icon-background.png", "PNG")
    print("Regenerated assets/android-icon-background.png")

    # -------------------------------------------------------------
    # 4. android-icon-foreground.png (512x512)
    # Android Adaptive safe area: inner circle radius = 170px from center (256, 256)
    # Total diameter = 340px
    # -------------------------------------------------------------
    fg = Image.new("RGBA", (SIZE_ADAPTIVE, SIZE_ADAPTIVE), (0, 0, 0, 0))
    fgd = ImageDraw.Draw(fg)

    fcx = SIZE_ADAPTIVE / 2
    fcy = SIZE_ADAPTIVE / 2 + 12
    fw = 200
    fh = 290
    fnotch = 55

    draw_bookmark(fgd, fcx - fw/2 - 4, fcy - fh/2 - 4, fcx + fw/2 + 4, fcy + fh/2 + 4, fnotch + 3, fill=(29, 155, 240, 50))
    draw_bookmark(fgd, fcx - fw/2, fcy - fh/2, fcx + fw/2, fcy + fh/2, fnotch, fill=BG_CARD, outline=ACCENT_BLUE, width=7)
    draw_official_x_logo(fgd, fcx, fcy - 32, 120, WHITE)
    fg.save("assets/android-icon-foreground.png", "PNG")
    print("Regenerated assets/android-icon-foreground.png")

    # -------------------------------------------------------------
    # 5. android-icon-monochrome.png (432x432)
    # Material You dynamic themed icon: clean white silhouette on transparent
    # Safe area radius: 144px from (216, 216)
    # -------------------------------------------------------------
    mono = Image.new("RGBA", (SIZE_MONO, SIZE_MONO), (0, 0, 0, 0))
    md = ImageDraw.Draw(mono)
    mcx = SIZE_MONO / 2
    mcy = SIZE_MONO / 2 + 10
    mw = 170
    mh = 246
    mnotch = 48
    draw_bookmark(md, mcx - mw/2, mcy - mh/2, mcx + mw/2, mcy + mh/2, mnotch, fill=(0, 0, 0, 0), outline=WHITE, width=10)
    draw_official_x_logo(md, mcx, mcy - 28, 105, WHITE)
    mono.save("assets/android-icon-monochrome.png", "PNG")
    print("Regenerated assets/android-icon-monochrome.png")

    # -------------------------------------------------------------
    # 6. favicon.png (48x48)
    # -------------------------------------------------------------
    fav = icon.resize((SIZE_FAV, SIZE_FAV), Image.Resampling.LANCZOS)
    fav.save("assets/favicon.png", "PNG")
    print("Regenerated assets/favicon.png")

if __name__ == "__main__":
    generate_all()
