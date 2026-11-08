#!/usr/bin/env python3
"""Compile the current SDK regression against the old plugin; require exit 10.

This is an actual AppKit/Core Animation baseline control, not a Native Rust
build, GPU render or WindowServer capture. The normal SDK builder separately
compiles/runs the same regression against the current plugin and requires zero.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time

OLD_HEAD = "233d82545ee3071cfd502bca9018808b8db5265a"
TEST_SOURCE = "bindings/Flutter/macos/tests/metal_view_animation_sdk_test.mm"
PLUGIN_SOURCE = "bindings/Flutter/macos/Classes/RhwpMetalPlugin.mm"


def checked_head(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("an exact lowercase 40-character source SHA is required")
    return value


def load_builder(repository):
    tool = repository / "bindings/Flutter/tool"
    sys.path.insert(0, str(tool))
    spec = importlib.util.spec_from_file_location("animation_policy_sdk_builder", tool / "check_macos_metal_sdk.py")
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    return builder


def source_identity(builder, repository, expected=None):
    head = checked_head(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository,
                                               text=True, timeout=30).strip())
    if expected is not None and head != expected:
        raise ValueError("baseline checkout differs from the exact old source SHA")
    files = builder.source_hashes(repository)
    digest = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"head": head, "trackedFiles": len(files), "gitIndexManifestSha256": digest,
            "kind": "clean-git-checkout-mode-blob-oid-manifest"}


def framework_identity(builder, framework):
    binary = (framework / "FlutterMacOS").resolve(strict=True)
    binary.relative_to(framework)
    identity = {"binarySha256": builder.digest(binary, maximum=512 * 1024**2), "headers": {}}
    headers = framework / "Headers"
    headers.resolve(strict=True).relative_to(framework)
    if not (headers / "FlutterMacOS.h").is_file():
        raise ValueError("the actual FlutterMacOS public headers are required")
    total = 0
    for item in sorted(headers.rglob("*")):
        resolved = item.resolve(strict=True)
        resolved.relative_to(framework)
        if resolved.is_dir():
            if item.is_symlink():
                raise ValueError("nested framework header directory links are unsupported")
            continue
        if not resolved.is_file():
            raise ValueError("framework header input must be a regular file")
        total += resolved.stat().st_size
        if len(identity["headers"]) >= 1024 or total > 64 * 1024**2:
            raise ValueError("framework public header inputs exceeded their bound")
        identity["headers"][item.relative_to(framework).as_posix()] = builder.digest(resolved, maximum=64 * 1024**2)
    module = framework / "Modules/module.modulemap"
    if module.is_file():
        resolved = module.resolve(strict=True)
        resolved.relative_to(framework)
        identity["moduleMapSha256"] = builder.digest(resolved, maximum=1024**2)
    return identity


def baseline_command(builder, repository, old_repository, output, sdk, clang, framework, architecture):
    commands, _ = builder.command_plan(repository, output, sdk, clang, framework, architecture,
                                        "1.93.1", output / "unused-native.dylib")
    matches = [command for command in commands if command[0] == str(clang) and
               str(repository / TEST_SOURCE) in command]
    if len(matches) != 1 or "-Werror" not in matches[0] or "-dynamiclib" in matches[0]:
        raise ValueError("one real executable SDK regression compile/link command is required")
    command = matches[0].copy()
    executable = output / "old-metal-view-animation-control"
    command[command.index("-o") + 1] = str(executable)
    command.insert(1, "-DRHWP_METAL_ANIMATION_PLUGIN_SOURCE=" + json.dumps(str(old_repository / PLUGIN_SOURCE)))
    if "cargo" in command or str(output / "unused-native.dylib") in command:
        raise ValueError("the baseline must never execute or link an unspecified Native binary")
    return command, executable


def expected_failure(log_path, code):
    log_path = Path(log_path)
    if log_path.stat().st_size > 1024 * 1024:
        raise ValueError("baseline regression log exceeds its diagnostic bound")
    diagnostic = log_path.read_text(errors="replace")
    if code != 10 or "implicit action lookup remained enabled: opacity" not in diagnostic:
        raise ValueError("old plugin must fail the opacity action regression with exact expected exit 10")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--old-repository", type=Path, required=True)
    parser.add_argument("--framework", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-old-head", default=OLD_HEAD)
    args = parser.parse_args()
    old_head = checked_head(args.expected_old_head)
    if sys.platform != "darwin" or platform.machine() not in ("arm64", "x86_64"):
        parser.error("actual macOS Apple SDK/AppKit execution is required")
    repository = args.repository.resolve(strict=True)
    old_repository = args.old_repository.resolve(strict=True)
    if repository == old_repository:
        parser.error("the previous plugin requires a separate immutable checkout")
    output = args.output.resolve()
    if output.is_relative_to(repository) or output.is_relative_to(old_repository):
        parser.error("private output must remain outside both source checkouts")
    builder = load_builder(repository)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    (output / "tmp").mkdir(mode=0o700)
    receipt = output / "macos-animation-baseline.json"
    state = {"platform": "macos", "qualification": "pending", "oldReferenceSourceHead": old_head,
             "steps": [], "nativeRustBuildExecuted": False, "nativeBinaryExecuted": False,
             "gpuRenderExecuted": False, "windowServerCaptureExecuted": False,
             "consumerGpuCompletionVerified": False, "started": time.time(), "pid": os.getpid()}
    try:
        current = source_identity(builder, repository)
        old = source_identity(builder, old_repository, old_head)
        test_hash = builder.digest(repository / TEST_SOURCE, maximum=1024**2)
        framework = args.framework.resolve(strict=True)
        if framework.name != "FlutterMacOS.framework":
            raise ValueError("the actual FlutterMacOS.framework is required")
        framework_before = framework_identity(builder, framework)
        sdk = Path(subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"],
                                          text=True, timeout=30).strip()).resolve(strict=True)
        clang = builder.find_apple_cxx()
        if clang.name != "clang++" or not clang.is_file():
            raise ValueError("the actual clang++ invocation must retain its C++ driver name")
        compiler = subprocess.check_output([str(clang), "--version"], text=True, timeout=30)
        if "Apple clang" not in compiler:
            raise ValueError("actual Apple clang++ is required")
        command, executable = baseline_command(builder, repository, old_repository, output,
                                               sdk, clang, framework, platform.machine())
        state.update(source_head=current["head"], currentReferenceSource=current, oldReferenceSource=old,
                     sdk=str(sdk), compiler=compiler, architecture=platform.machine(),
                     regressionSource=str(repository / TEST_SOURCE), regressionSourceSha256=test_hash,
                     frameworkInputs=framework_before, baselineCompileCommand=command,
                     fixedSourceRegressionPolicy="normal SDK builder independently requires exit 0; not executed by this driver")
        builder.write_json(receipt, state)
        env = dict(os.environ, TMPDIR=str(output / "tmp"))
        deadline = time.monotonic() + 600
        for index, child_command in enumerate((command, [str(executable)])):
            if (source_identity(builder, repository) != current or
                    source_identity(builder, old_repository, old_head) != old or
                    framework_identity(builder, framework) != framework_before or
                    builder.digest(repository / TEST_SOURCE, maximum=1024**2) != test_hash):
                raise ValueError("source/framework/regression input changed before baseline execution")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("actual animation baseline exceeded its overall deadline")
            log = output / f"step-{index}.log"
            step = {"command": child_command, "started": time.time(), "exitCode": None, "log": str(log)}
            state["steps"].append(step)
            code = builder.execute_step(child_command, repository=repository, env=env, log_path=log,
                step=step, record=lambda: builder.write_json(receipt, state), timeout=min(180, remaining))
            if index == 0 and code != 0:
                raise RuntimeError("old-source SDK compile/link failed; this is not the expected runtime regression")
            if index == 1:
                expected_failure(log, code)
            if (source_identity(builder, repository) != current or
                    source_identity(builder, old_repository, old_head) != old or
                    framework_identity(builder, framework) != framework_before or
                    builder.digest(repository / TEST_SOURCE, maximum=1024**2) != test_hash):
                raise ValueError("source/framework/regression input changed during baseline execution")
            if time.monotonic() >= deadline:
                raise TimeoutError("actual animation baseline final validation exceeded its deadline")
        executable_hash = builder.digest(executable, maximum=512 * 1024**2)
        if time.monotonic() >= deadline:
            raise TimeoutError("actual animation baseline artifact validation exceeded its deadline")
        state.update(qualification="old-metal-view-implicit-action-control-reproduced", baselineSdkCompileLinkVerified=True,
                     expectedBaselineExitCode=10, actualBaselineExitCode=state["steps"][1]["exitCode"],
                     baselineImplicitActionRegressionReproduced=True, sourceStable=True,
                     sameRegressionSourceUsedByCurrentSdkPlan=True,
                     baselineExecutableSha256=executable_hash)
    except BaseException as error:
        state.update(qualification="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        state["finished"] = time.time()
        builder.write_json(receipt, state)
    print(receipt)


if __name__ == "__main__":
    main()
