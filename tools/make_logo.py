# ZRB logo 生成：桥 + 知识节点，蓝色渐变圆角方块
# 输出 addon/content/icons/favicon.png (96) 与 favicon@0.5x.png (48)
# 4x 超采样抗锯齿。设计与 sidebarMarkup.ts 内联 SVG 保持一致。
from PIL import Image, ImageDraw

S = 4  # supersample
SIZE = 96


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(size):
    n = size * S
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    # 渐变底：逐行填充后套圆角蒙版
    grad = Image.new("RGBA", (n, n))
    gd = ImageDraw.Draw(grad)
    c0, c1 = (63, 143, 224), (31, 95, 168)
    for y in range(n):
        gd.line([(0, y), (n, y)], fill=lerp(c0, c1, y / n) + (255,))
    mask = Image.new("L", (n, n), 0)
    md = ImageDraw.Draw(mask)
    k = n / 96
    md.rounded_rectangle([4 * k, 4 * k, 92 * k, 92 * k], radius=22 * k, fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)
    mint = (143, 227, 192, 255)

    def pt(x, y):
        return (x * k, y * k)

    # 桥拱：贝塞尔近似（与 SVG path M26 62 C26 42 70 42 70 62 一致）
    pts = []
    for i in range(61):
        t = i / 60
        x = (1 - t) ** 3 * 26 + 3 * (1 - t) ** 2 * t * 26 + 3 * (1 - t) * t * t * 70 + t ** 3 * 70
        y = (1 - t) ** 3 * 62 + 3 * (1 - t) ** 2 * t * 42 + 3 * (1 - t) * t * t * 42 + t ** 3 * 62
        pts.append(pt(x, y))
    d.line(pts, fill=white, width=round(6 * k), joint="curve")
    for cx, cy in [pts[0], pts[-1]]:
        r = 3 * k
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=white)
    # 桥墩
    for x in (26, 70):
        d.line([pt(x, 62), pt(x, 70)], fill=white, width=round(6 * k))
        cx, cy = pt(x, 70)
        r = 3 * k
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=white)
    # 桥面
    d.line([pt(20, 70), pt(76, 70)], fill=(255, 255, 255, 217), width=round(5 * k))
    for x in (20, 76):
        cx, cy = pt(x, 70)
        r = 2.5 * k
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 217))
    # 知识节点
    cx, cy = pt(48, 34)
    r = 6 * k
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=mint)
    d.line([pt(48, 40), pt(48, 50)], fill=mint, width=round(4 * k))
    cx, cy = pt(48, 50)
    r = 2 * k
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=mint)

    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    import sys
    from pathlib import Path

    out = Path(sys.argv[1])
    render(96).save(out / "favicon.png")
    render(48).save(out / "favicon@0.5x.png")
    print("written:", out / "favicon.png", out / "favicon@0.5x.png")