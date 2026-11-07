"""Renders every formula listed in formulas.txt with MathTex (REQ-vid-02).

verify.sh passes the list in LH_FORMULAS_FILE and the report path in
LH_FORMULA_REPORT. Each formula is compiled by the bundled LaTeX; a failure is
recorded and the scene goes on, so one report lists every broken formula.
Rendered as: <root>/bin/manim -ql --disable_caching -o formulas formulas_scene.py Formulas
"""
import os

from manim import MathTex, Scene, TexTemplate, Write

# The preamble the runtime promises: Manim's default template plus mathtools and bm
# (the same set build.sh compiles into the TeX closure).
TEMPLATE = TexTemplate()
TEMPLATE.add_to_preamble(r"\usepackage{mathtools}")
TEMPLATE.add_to_preamble(r"\usepackage{bm}")


class Formulas(Scene):
    def construct(self):
        path = os.environ["LH_FORMULAS_FILE"]
        report = os.environ["LH_FORMULA_REPORT"]
        with open(path, encoding="utf-8") as fh:
            formulas = [line.rstrip("\n") for line in fh if line.strip() and not line.lstrip().startswith("#")]
        lines = []
        for index, latex in enumerate(formulas, start=1):
            try:
                mob = MathTex(latex, tex_template=TEMPLATE)
                self.play(Write(mob), run_time=0.2)
                self.remove(mob)
                lines.append(f"OK\t{index}\t{latex}")
            except Exception as exc:  # report every failing formula, not only the first
                first = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
                lines.append(f"FAIL\t{index}\t{latex}\t{first[:300]}")
        with open(report, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
