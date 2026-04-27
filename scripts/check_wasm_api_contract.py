#!/usr/bin/env python3
"""Verify the public WASM rendering API and its layered replay contract."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


parser = argparse.ArgumentParser(
    description=(
        "Check that rendering wasm-bindgen exports are connected and that "
        "renderPageToCanvas remains on the PageLayerTree replay path."
    )
)
parser.add_argument(
    "--pkg",
    type=Path,
    default=None,
    help="wasm-pack output directory to inspect for generated JS/TS exports",
)
parser.add_argument(
    "--require-generated",
    action="store_true",
    help="fail if the generated wasm-pack output is missing",
)
args = parser.parse_args()

repo_root = Path(__file__).resolve().parents[1]
pkg_dir = args.pkg
if pkg_dir is None and args.require_generated:
    pkg_dir = repo_root / "pkg"
if pkg_dir is not None and not pkg_dir.is_absolute():
    pkg_dir = repo_root / pkg_dir

errors: list[str] = []

wasm_api_path = repo_root / "src" / "wasm_api.rs"
render_path = repo_root / "src" / "wasm_api" / "render.rs"
web_canvas_path = repo_root / "src" / "renderer" / "web_canvas.rs"

try:
    wasm_api_source = wasm_api_path.read_text(encoding="utf-8")
except OSError as exc:
    errors.append(f"failed to read {wasm_api_path}: {exc}")
    wasm_api_source = ""

try:
    render_source = render_path.read_text(encoding="utf-8")
except OSError as exc:
    errors.append(f"failed to read {render_path}: {exc}")
    render_source = ""

try:
    web_canvas_source = web_canvas_path.read_text(encoding="utf-8")
except OSError as exc:
    errors.append(f"failed to read {web_canvas_path}: {exc}")
    web_canvas_source = ""

def rust_body_after(source: str, marker: str) -> str | None:
    method_start = source.find(marker)
    if method_start < 0:
        return None
    method_open = source.find("{", method_start)
    if method_open < 0:
        return None
    depth = 0
    for index in range(method_open, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[method_open:index + 1]
    return None

if not re.search(r"(?m)^\s*(?:pub\(crate\)\s+)?mod\s+render\s*;", wasm_api_source):
    errors.append("src/wasm_api.rs does not connect src/wasm_api/render.rs")

required_js_names = [
    "renderPageToCanvas",
    "renderPageSvgLegacy",
    "renderPageSvgLayer",
    "getPageLayerTree",
    "getPageLayerTreeWithProfile",
    "getPageLayerTreeValue",
    "getPageLayerTreeValueWithProfile",
    "getPageLayerTreeValueWithProfileAndResourceKeys",
]

for js_name in required_js_names:
    if f"js_name = {js_name}" not in render_source:
        errors.append(f"src/wasm_api/render.rs is missing wasm-bindgen js_name {js_name}")

method_body = rust_body_after(render_source, "pub fn render_page_to_canvas")
if method_body is None:
    errors.append("render_page_to_canvas method is missing")
else:
    if "build_page_layer_tree_for_output" not in method_body:
        errors.append(
            "render_page_to_canvas no longer builds PageLayerTree via "
            "build_page_layer_tree_for_output"
        )
    if "render_layer_tree" not in method_body:
        errors.append(
            "render_page_to_canvas no longer replays PageLayerTree via "
            "WebCanvasRenderer::render_layer_tree"
        )
    if "build_page_tree_cached" in method_body:
        errors.append(
            "render_page_to_canvas regressed to the legacy PageRenderTree builder"
        )
    if re.search(r"\.render_tree\s*\(", method_body):
        errors.append(
            "render_page_to_canvas regressed to WebCanvasRenderer::render_tree"
        )

layer_tree_body = rust_body_after(web_canvas_source, "pub fn render_layer_tree")
layer_node_body = rust_body_after(web_canvas_source, "fn render_layer_node")
if layer_tree_body is None:
    errors.append("WebCanvasRenderer::render_layer_tree method is missing")
elif re.search(r"\.render_tree\s*\(", layer_tree_body):
    errors.append("WebCanvasRenderer::render_layer_tree regressed to legacy render_tree")

if layer_node_body is None:
    errors.append("WebCanvasRenderer::render_layer_node method is missing")
else:
    if re.search(r"\brender_node\s*\(", layer_node_body):
        errors.append("WebCanvasRenderer::render_layer_node regressed to legacy render_node")
    if "PaintOp::" not in layer_node_body:
        errors.append("WebCanvasRenderer::render_layer_node no longer replays PaintOp directly")

generated_files = []
if pkg_dir is not None and pkg_dir.exists():
    generated_files.extend(sorted(pkg_dir.glob("*.js")))
    generated_files.extend(sorted(pkg_dir.glob("*.d.ts")))

if generated_files:
    generated_text = "\n".join(
        file.read_text(encoding="utf-8", errors="replace") for file in generated_files
    )
    for js_name in required_js_names:
        if js_name not in generated_text:
            errors.append(
                f"generated wasm-pack output under {pkg_dir} is missing {js_name}"
            )
elif args.require_generated:
    errors.append(f"generated wasm-pack output was required but not found under {pkg_dir}")

if errors:
    print("WASM API contract check failed:", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    sys.exit(1)

if generated_files:
    print(
        "WASM API contract check passed "
        f"({len(required_js_names)} exports, {len(generated_files)} generated files)."
    )
else:
    print(
        "WASM API source contract check passed "
        "(generated wasm-pack output was not inspected)."
    )
