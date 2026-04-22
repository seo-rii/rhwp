#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SAMPLES_DIR = ROOT / "samples"
STUDIO_ROOT = ROOT / "rhwp-studio"
DEFAULT_MANIFEST = ROOT / "scripts" / "renderer_baseline_manifest.json"
DEFAULT_OUTPUT = ROOT / "output" / "renderer-baseline" / "latest"
NPM_CMD = "npm.cmd" if sys.platform == "win32" else "npm"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Capture a fixed multi-backend renderer baseline for transition hardening."
    )
    parser.add_argument(
        "--manifest",
        default=str(DEFAULT_MANIFEST),
        help="baseline manifest JSON path",
    )
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT),
        help="output directory for captured artifacts",
    )
    parser.add_argument(
        "--filter",
        default="",
        help="regex filter applied to sample id/file/category",
    )
    parser.add_argument(
        "--browser-mode",
        choices=("host", "headless"),
        default="headless",
        help="browser capture mode for rhwp-studio baseline screenshots",
    )
    parser.add_argument(
        "--skip-native",
        action="store_true",
        help="skip legacy svg / layer svg / native skia captures",
    )
    parser.add_argument(
        "--skip-browser",
        action="store_true",
        help="skip canvas2d / canvaskit browser captures",
    )
    return parser.parse_args()


def load_manifest(manifest_path: Path, filter_pattern: str) -> dict:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    samples = manifest.get("samples", [])
    if not isinstance(samples, list) or not samples:
        raise SystemExit("baseline manifest must contain a non-empty samples array")

    filter_re = re.compile(filter_pattern, re.IGNORECASE) if filter_pattern else None
    selected = []
    for sample in samples:
        file_name = sample["file"]
        sample_id = sample.get("id") or Path(file_name).stem
        category = sample.get("category", "uncategorized")
        page = int(sample.get("page", 0))
        if filter_re and not (
            filter_re.search(sample_id)
            or filter_re.search(file_name)
            or filter_re.search(category)
        ):
            continue
        selected.append(
            {
                "id": sample_id,
                "file": file_name,
                "category": category,
                "page": page,
                "notes": sample.get("notes", ""),
            }
        )

    if not selected:
        raise SystemExit("sample filter removed every manifest entry")

    manifest["samples"] = selected
    return manifest


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def command_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    if extra:
        env.update(extra)
    return env


def log_command(cmd: list[str], cwd: Path) -> None:
    printable = " ".join(cmd)
    print(f"$ (cd {cwd} && {printable})", flush=True)


def run_command(cmd: list[str], cwd: Path, extra_env: dict[str, str] | None = None) -> None:
    log_command(cmd, cwd)
    subprocess.run(cmd, cwd=cwd, env=command_env(extra_env), check=True)


def collect_files(output_dir: Path, suffix: str) -> list[str]:
    return sorted(str(path.relative_to(ROOT)) for path in output_dir.glob(f"*{suffix}"))


def capture_native_sample(sample: dict, output_root: Path) -> list[dict]:
    sample_path = SAMPLES_DIR / sample["file"]
    if not sample_path.exists():
        raise SystemExit(f"sample file not found: {sample_path}")

    outputs: list[dict] = []
    target_page = str(sample["page"])

    legacy_dir = output_root / sample["id"] / "legacy-svg"
    if legacy_dir.exists():
        shutil.rmtree(legacy_dir)
    ensure_dir(legacy_dir)
    run_command(
        [
            "cargo",
            "run",
            "--bin",
            "rhwp",
            "--",
            "export-svg",
            str(sample_path),
            "--page",
            target_page,
            "--output",
            str(legacy_dir),
        ],
        ROOT,
    )
    outputs.append({"backend": "legacy-svg", "files": collect_files(legacy_dir, ".svg")})

    layer_dir = output_root / sample["id"] / "layer-svg"
    if layer_dir.exists():
        shutil.rmtree(layer_dir)
    ensure_dir(layer_dir)
    run_command(
        [
            "cargo",
            "run",
            "--bin",
            "rhwp",
            "--",
            "export-svg",
            str(sample_path),
            "--page",
            target_page,
            "--output",
            str(layer_dir),
        ],
        ROOT,
        {"RHWP_RENDER_PATH": "layer-svg"},
    )
    outputs.append({"backend": "layer-svg", "files": collect_files(layer_dir, ".svg")})

    skia_dir = output_root / sample["id"] / "native-skia"
    if skia_dir.exists():
        shutil.rmtree(skia_dir)
    ensure_dir(skia_dir)
    run_command(
        [
            "cargo",
            "run",
            "--features",
            "native-skia",
            "--bin",
            "rhwp",
            "--",
            "export-png",
            str(sample_path),
            "--page",
            target_page,
            "--output",
            str(skia_dir),
        ],
        ROOT,
    )
    outputs.append({"backend": "native-skia", "files": collect_files(skia_dir, ".png")})

    return outputs


def find_available_port(start_port: int = 7700, attempts: int = 20) -> int:
    for port in range(start_port, start_port + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise SystemExit(f"failed to find an available port starting at {start_port}")


def wait_for_server(url: str, timeout_sec: float = 30.0) -> None:
    deadline = time.time() + timeout_sec
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url) as response:
                if response.status < 500:
                    return
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
        time.sleep(0.5)
    raise SystemExit(f"timed out waiting for {url}: {last_error}")


def stop_process(child: subprocess.Popen[bytes]) -> None:
    if child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=5)


def capture_browser_baseline(
    manifest_path: Path,
    output_root: Path,
    browser_mode: str,
    filter_pattern: str,
) -> Path:
    port = find_available_port()
    vite_url = f"http://127.0.0.1:{port}"
    dev_server = subprocess.Popen(
        [
            NPM_CMD,
            "run",
            "dev",
            "--",
            "--host",
            "0.0.0.0",
            "--port",
            str(port),
            "--strictPort",
        ],
        cwd=STUDIO_ROOT,
        env=command_env({"BROWSER": "none"}),
    )
    try:
        wait_for_server(vite_url)
        cmd = [
            "node",
            "e2e/renderer-baseline.mjs",
            f"--mode={browser_mode}",
            f"--manifest={manifest_path}",
            f"--output={output_root}",
        ]
        if filter_pattern:
            cmd.append(f"--filter={filter_pattern}")
        run_command(cmd, STUDIO_ROOT, {"VITE_URL": vite_url})
    finally:
        stop_process(dev_server)
    return output_root / "browser-baseline-report.json"


def repo_relative(path_value: str | Path) -> str:
    path = Path(path_value)
    if not path.is_absolute():
        path = (ROOT / path).resolve()
    return str(path.relative_to(ROOT))


def write_reports(manifest: dict, output_root: Path, native_results: list[dict], browser_report: Path | None) -> None:
    browser_data = None
    if browser_report and browser_report.exists():
        browser_data = json.loads(browser_report.read_text(encoding="utf-8"))

    report_json = {
        "manifest": manifest,
        "native": native_results,
        "browser": browser_data,
    }
    (output_root / "baseline-report.json").write_text(
        json.dumps(report_json, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    lines = [
        f"# Renderer Baseline: {manifest.get('label', 'unnamed')}",
        "",
        manifest.get("description", ""),
        "",
        f"- manifest: `{Path(manifest.get('_path', '')).relative_to(ROOT) if manifest.get('_path') else 'n/a'}`",
        f"- samples: {len(manifest['samples'])}",
        "",
        "## Sample Matrix",
        "",
        "| Sample | Category | Native Outputs | Browser Outputs |",
        "| --- | --- | --- | --- |",
    ]

    browser_by_sample: dict[str, list[str]] = {}
    if browser_data:
        for item in browser_data.get("results", []):
            browser_by_sample.setdefault(item["sampleId"], []).append(item["path"])

    for sample in manifest["samples"]:
        native_entries = next((entry for entry in native_results if entry["sampleId"] == sample["id"]), None)
        native_paths: list[str] = []
        if native_entries:
            for backend in native_entries["backends"]:
                native_paths.extend(backend["files"])
        browser_paths = browser_by_sample.get(sample["id"], [])
        native_text = "<br>".join(f"`{path}`" for path in native_paths) or "-"
        browser_text = "<br>".join(f"`{repo_relative(path)}`" for path in browser_paths) or "-"
        lines.append(
            f"| {sample['id']} | {sample['category']} | {native_text} | {browser_text} |"
        )

    (output_root / "baseline-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    manifest_path = Path(args.manifest).resolve()
    output_root = Path(args.output).resolve()
    ensure_dir(output_root)

    manifest = load_manifest(manifest_path, args.filter)
    manifest["_path"] = str(manifest_path)
    shutil.copy2(manifest_path, output_root / manifest_path.name)

    filtered_manifest_path = output_root / "baseline-manifest.filtered.json"
    filtered_manifest_path.write_text(
        json.dumps(
            {
                key: value
                for key, value in manifest.items()
                if key != "_path"
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    native_results: list[dict] = []
    if not args.skip_native:
        for sample in manifest["samples"]:
            print(f"\n[native] {sample['id']} ({sample['category']})", flush=True)
            backends = capture_native_sample(sample, output_root)
            native_results.append(
                {
                    "sampleId": sample["id"],
                    "backends": backends,
                }
            )

    browser_report: Path | None = None
    if not args.skip_browser:
        print("\n[browser] capturing canvas2d/canvaskit baseline", flush=True)
        browser_report = capture_browser_baseline(
            filtered_manifest_path,
            output_root / "browser",
            args.browser_mode,
            args.filter,
        )

    write_reports(manifest, output_root, native_results, browser_report)
    print(f"\n[baseline] complete: {output_root}", flush=True)


if __name__ == "__main__":
    main()
