"""
Genera un icono cuadrado con fondo blanco y esquinas redondeadas,
con el ojo de splash-eye.png centrado encima.
"""
from PIL import Image, ImageDraw
import sys, os

SIZE = 512
RADIUS = 100  # radio de esquinas redondeadas
PADDING = 60  # espacio entre borde del ojo y el borde del icono

def rounded_rect_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask

def main():
    src = os.path.join(os.path.dirname(__file__), "public", "splash-eye.png")
    eye = Image.open(src).convert("RGBA")

    # Redimensionar el ojo para que quepa con padding
    eye_size = SIZE - PADDING * 2
    eye = eye.resize((eye_size, eye_size), Image.LANCZOS)

    # Crear lienzo blanco con esquinas redondeadas
    canvas = Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 255))
    mask = rounded_rect_mask(SIZE, RADIUS)
    canvas.putalpha(mask)

    # Pegar el ojo centrado (respetando su canal alfa)
    canvas.paste(eye, (PADDING, PADDING), eye)

    out = os.path.join(os.path.dirname(__file__), "public", "splash-eye-icon.png")
    canvas.save(out)
    print(f"Guardado: {out} ({SIZE}x{SIZE})")

if __name__ == "__main__":
    main()
