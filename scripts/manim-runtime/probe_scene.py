"""Probe scene for the Manim runtime (REQ-vid-03).

Rendered by verify.sh as: <root>/bin/manim -ql --disable_caching -o scene scene.py Scene
The class must stay named Scene: the runtime contract fixes that render command.
"""
from manim import Circle, MathTex, Create, Scene as _Scene, Square, Transform, Write, BLUE, RED, UP


class Scene(_Scene):
    def construct(self):
        circle = Circle(color=BLUE)
        square = Square(color=RED)
        formula = MathTex(r"e^{i\pi} + 1 = 0").shift(UP * 2)
        self.play(Create(circle), Write(formula))
        self.wait(0.2)
        self.play(Transform(circle, square))
        self.wait(0.2)
