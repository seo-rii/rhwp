#!/usr/bin/env python3
"""Actual P107 Apple SDK qualification with a caller-supplied Native dylib.

The reference plugin/bridge/producer execute from the exact requested source.
The supplied Native binary is identified separately and is never called a fresh
build or claimed to have equivalent build inputs to the reference checkout.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import time

NATIVE_STATS = ("sources", "snapshotHandles", "retainedSnapshots", "snapshotEstimatedBytes",
                "frameHandles", "retainedFrames", "frameBytes", "leases", "inFlightReplays")
CONTROL_NAMES = ("opaque", "premultiplied-alpha", "stale-preserves-target")


def checked_head(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("an exact lowercase 40-character source SHA is required")
    return value


def load_reference_builder(repository):
    tool = repository / "bindings/Flutter/tool"
    sys.path.insert(0, str(tool))
    spec = importlib.util.spec_from_file_location("p107_reference_sdk_builder", tool / "check_macos_metal_sdk.py")
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    return builder


def reference_identity(builder, repository, expected_head):
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository, text=True, timeout=30).strip()
    if head != expected_head:
        raise ValueError("reference checkout HEAD differs from the exact requested source")
    # This also rejects tracked modifications/untracked source and unmerged index.
    files = builder.source_hashes(repository)
    encoded = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    return {"head": head, "trackedFiles": len(files),
            "manifestSha256": hashlib.sha256(encoded).hexdigest(),
            "manifestKind": "clean-reference-checkout-git-index-mode-and-blob-oid"}


def qualification_plan(builder, repository, output, sdk, clang, framework, architecture, native, expected_head):
    commands, artifacts = builder.command_plan(repository, output, sdk, clang, framework, architecture, "1.93.1")
    skipped = [command for command in commands if "cargo" in command]
    if len(skipped) != 1 or "build" not in skipped[0] or "native-skia-metal" not in skipped[0]:
        raise ValueError("unexpected original P107 Native-build plan")
    compiled = [command for command in commands if command[0] == str(clang)]
    if len(compiled) != 2 or any("-Werror" not in command or "-dynamiclib" not in command for command in compiled):
        raise ValueError("P107 must compile/link exactly its plugin and Metal probe with warnings as errors")
    original_native = str(artifacts["native"])
    rewritten = [[str(native) if value == original_native else expected_head if value == "SOURCE_HEAD" else value
                  for value in command] for command in commands if "cargo" not in command]
    if not rewritten or "native_metal_sdk_contract.py" not in " ".join(rewritten[-1]):
        raise ValueError("P107 actual independent Metal producer must remain the final step")
    artifacts["native"] = native
    return [["xcrun", "lipo", str(framework / "FlutterMacOS"), "-verify_arch", architecture],
            ["xcrun", "lipo", str(native), "-verify_arch", architecture], *rewritten], artifacts, skipped


def validate_producer(proof, expected_head, native_sha256):
    if proof.get("status") != "passed" or proof.get("source_head") != expected_head:
        raise ValueError("actual P107 Metal producer did not pass at the exact reference source")
    if proof.get("nativeSha256") != native_sha256 or proof.get("producerReadbackVerified") is not True:
        raise ValueError("actual producer did not use the supplied Native binary/readback")
    if proof.get("consumerGpuCompletionVerified") is not False or proof.get("flutterConsumerSamplingVerified") is not False:
        raise ValueError("producer probe cannot certify Flutter consumer completion or pixels")
    results = proof.get("results")
    if not isinstance(results, list) or tuple(item.get("name") for item in results) != CONTROL_NAMES:
        raise ValueError("all three independent opaque/alpha/stale controls are required")
    stats = proof.get("stats", {})
    if any(type(stats.get(key)) is not int or stats[key] != 0 for key in NATIVE_STATS):
        raise ValueError("actual Native source/snapshot/frame/lease teardown did not return to zero")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--framework", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--native-source-head", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-head", required=True)
    args = parser.parse_args()
    expected = checked_head(args.expected_head)
    native_source = checked_head(args.native_source_head)
    if sys.platform != "darwin" or platform.machine() not in ("arm64", "x86_64"):
        parser.error("actual macOS Apple SDK/Metal execution is required")
    repository = args.repository.resolve(strict=True)
    output = args.output.resolve()
    if output.is_relative_to(repository):
        parser.error("private output must be outside the immutable reference checkout")
    builder = load_reference_builder(repository)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    (output / "tmp").mkdir(mode=0o700)
    receipt = output / "p107-macos-sdk-review.json"
    state = {"platform": "macos", "qualification": "pending", "referenceSourceHead": expected,
             "source_head": expected, "nativeSourceHead": native_source,
             "nativeSourceIdentityKind": "caller-declared-supplied-binary-source; identified-by-sha256",
             "nativeRebuilt": False, "nativeInputEquivalenceVerified": False,
             "consumerGpuCompletionVerified": False, "flutterConsumerSamplingVerified": False,
             "continuousPresentationSupported": False,
             "hardwareAccelerationVerified": False, "steps": [], "started": time.time(), "pid": os.getpid()}
    try:
        initial = reference_identity(builder, repository, expected)
        state["referenceSourceIdentity"] = initial
        framework = args.framework.resolve(strict=True)
        if framework.name != "FlutterMacOS.framework" or not (framework / "Headers/FlutterMacOS.h").is_file():
            raise ValueError("the real FlutterMacOS framework and public headers are required")
        framework_binary = (framework / "FlutterMacOS").resolve(strict=True)
        if args.native.is_symlink():
            raise ValueError("supplied Native dylib must be an owned regular file")
        native = args.native.resolve(strict=True)
        info = native.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= 512 * 1024**2:
            raise ValueError("supplied Native dylib must be one bounded non-hardlinked regular file")
        native_hash = builder.digest(native, maximum=512 * 1024**2)
        framework_hash = builder.digest(framework_binary, maximum=512 * 1024**2)
        sdk = Path(subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True, timeout=30).strip()).resolve(strict=True)
        clang = builder.find_apple_cxx()
        if clang.name != "clang++" or not clang.is_file():
            raise ValueError("the original P107 helper must preserve its actual clang++ invocation")
        compiler = subprocess.check_output([str(clang), "--version"], text=True, timeout=30)
        if "Apple clang" not in compiler:
            raise ValueError("the actual Apple clang++ SDK compiler is required")
        commands, artifacts, skipped = qualification_plan(builder, repository, output, sdk, clang,
            framework, platform.machine(), native, expected)
        state.update(nativeSha256=native_hash, nativeBytes=info.st_size, architecture=platform.machine(),
                     sdk=str(sdk), compiler=compiler, frameworkSha256=framework_hash,
                     skippedOriginalNativeBuildCommands=skipped)
        builder.write_json(receipt, state)
        env = dict(os.environ, TMPDIR=str(output / "tmp"))
        deadline = time.monotonic() + 600
        for command in commands:
            if reference_identity(builder, repository, expected) != initial:
                raise ValueError("reference checkout changed before an actual SDK step")
            if builder.digest(native, maximum=512 * 1024**2) != native_hash or builder.digest(framework_binary, maximum=512 * 1024**2) != framework_hash:
                raise ValueError("the supplied Native/framework changed before an actual SDK step")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("P107 actual SDK review exceeded its overall deadline")
            index = len(state["steps"])
            step = {"command": command, "started": time.time(), "exitCode": None,
                    "log": str(output / f"step-{index}.log")}
            state["steps"].append(step)
            code = builder.execute_step(command, repository=repository, env=env, log_path=step["log"],
                step=step, record=lambda: builder.write_json(receipt, state), timeout=min(180, remaining))
            if code:
                raise RuntimeError("actual P107 SDK step failed; inspect its completed log: " + step["log"])
            if reference_identity(builder, repository, expected) != initial:
                raise ValueError("reference checkout changed during actual SDK verification")
            if builder.digest(native, maximum=512 * 1024**2) != native_hash or builder.digest(framework_binary, maximum=512 * 1024**2) != framework_hash:
                raise ValueError("the supplied Native/framework changed during an actual SDK step")
            if time.monotonic() >= deadline:
                raise TimeoutError("P107 actual SDK validation exceeded its overall deadline")
        producer = output / "metal-producer.json"
        if producer.stat().st_size > 512 * 1024:
            raise ValueError("actual Metal producer receipt exceeded its byte bound")
        proof = json.loads(producer.read_text())
        validate_producer(proof, expected, native_hash)
        if builder.digest(native, maximum=512 * 1024**2) != native_hash or builder.digest(framework_binary, maximum=512 * 1024**2) != framework_hash:
            raise ValueError("the supplied Native/framework changed during actual verification")
        if time.monotonic() >= deadline:
            raise TimeoutError("P107 actual SDK final validation exceeded its overall deadline")
        state.update(qualification="p107-actual-apple-sdk-and-metal-producer-passed", build="passed",
                     targetSdkCompileLinkVerified=True, producerReadbackVerified=True,
                     metalProducerReadbackVerified=True,
                     sourceStable=True, nativeBinaryStable=True, stats=proof["stats"],
                     producerReceiptSha256=builder.digest(producer),
                     artifacts={key: {"path": str(path), "sha256": builder.digest(path), "bytes": path.stat().st_size}
                                for key, path in artifacts.items()})
    except BaseException as error:
        state.update(qualification="failed", build="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        state["finished"] = time.time()
        builder.write_json(receipt, state)
    print(receipt)


if __name__ == "__main__":
    main()
