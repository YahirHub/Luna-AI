from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGETS = [
    ROOT / "src" / "research-agent.ts",
    ROOT / "src" / "research" / "pricing-extractor.ts",
    ROOT / "src" / "orchestration" / "parallel-research.ts",
    ROOT / "__tests__" / "research-agent.test.ts",
    ROOT / "__tests__" / "pricing-extractor.test.ts",
]

for target in TARGETS:
    if target.exists():
        target.unlink()
        print(f"Eliminado: {target.relative_to(ROOT)}")
    else:
        print(f"No existe: {target.relative_to(ROOT)}")

research_dir = ROOT / "src" / "research"
if research_dir.exists() and not any(research_dir.iterdir()):
    research_dir.rmdir()
    print("Eliminado directorio vacío: src/research")
