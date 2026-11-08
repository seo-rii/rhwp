#!/usr/bin/env python3
"""Run the corrected P106 checkout on actual Windows with the qualified seed DLL.

This separate, exact-head qualification does not infer Native input equivalence,
rebuild Rust, or treat producer readback as Flutter consumer sampling.
"""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

FLUTTER_HEAD = "c197ca5199e9ee5661e865596c9c07294dfab51c"
ENGINE_HEAD = "89c39edfdfae2949f6806e4a315c0c08522238b7"
NATIVE_HEAD = "9452099dc796ca5626f1c4b52396a9ca07dc445e"
NATIVE_SHA256 = "79dac58c30367d477e87c8c13f962f30a2d8f336a1be57016aac7428ca4c1895"
MAX_JSON = 2 * 1024 * 1024
MAX_NATIVE = 512 * 1024 * 1024
NATIVE_STATS = ("sources", "snapshotHandles", "retainedSnapshots", "snapshotEstimatedBytes",
                "frameHandles", "retainedFrames", "frameBytes", "leases", "inFlightReplays")


def require_windows():
    if sys.platform != "win32":
        raise RuntimeError("P106 actual qualification requires genuine Windows")
    nt = ctypes.WinDLL("ntdll", use_last_error=True)
    if getattr(nt, "wine_get_version", None) is not None:
        raise RuntimeError("Wine is not genuine Windows qualification")


def read_json(path, limit=MAX_JSON):
    with Path(path).open("rb") as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ValueError("qualification JSON exceeds its byte bound")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("qualification JSON must be an object")
    return value


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
        json.dump(value, output, indent=2)
        output.write("\n")
    temporary.replace(path)


def digest(path, maximum=MAX_NATIVE):
    result = hashlib.sha256()
    total = 0
    with Path(path).open("rb") as source:
        for data in iter(lambda: source.read(1024 * 1024), b""):
            total += len(data)
            if total > maximum:
                raise ValueError("qualification input exceeds its byte bound")
            result.update(data)
    return result.hexdigest()


def native_identity(native, receipt):
    # The original successful 945 inner receipt predates target/features fields.
    # Its exact source and known actual D3D DLL hash are the authority; do not
    # manufacture missing build metadata or claim a new Rust build.
    if receipt.get("build") != "passed" or receipt.get("source_head") != NATIVE_HEAD:
        raise ValueError("P106 requires the successful, explicit 945 Windows D3D seed receipt")
    for key, expected in (("platform", "windows"), ("target", "x86_64-pc-windows-msvc")):
        if key in receipt and receipt[key] != expected:
            raise ValueError("P106 Native seed has contradictory target metadata")
    if "features" in receipt and "native-skia-d3d" not in receipt["features"]:
        raise ValueError("P106 Native seed has contradictory D3D feature metadata")
    recorded = receipt.get("artifacts", {}).get("rhwp_native_ffi.dll")
    if isinstance(recorded, dict):
        recorded = recorded.get("sha256")
    if recorded != NATIVE_SHA256 or digest(native) != NATIVE_SHA256:
        raise ValueError("P106 Native DLL/receipt differs from the qualified 945 seed")
    return {"sourceHead": NATIVE_HEAD, "sha256": NATIVE_SHA256,
            "bytes": native.stat().st_size, "nativeRebuilt": False,
            "nativeInputEquivalenceVerified": False}


def source_identity(repository, expected_head):
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository, text=True).strip()
    if head != expected_head:
        raise ValueError("P106 checkout is not the requested exact source head")
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=repository):
        raise ValueError("P106 checkout must remain completely committed and clean")
    paths = subprocess.check_output(["git", "ls-files", "-z", "--", "bindings/Flutter",
                                     "bindings/swift/Sources/CRhwpNative"], cwd=repository).split(b"\0")
    paths = [os.fsdecode(path) for path in paths if path]
    if not 1 <= len(paths) <= 1024:
        raise ValueError("P106 tracked runtime-source count is outside its bound")
    files = {}
    for relative in paths:
        if Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise ValueError("P106 tracked runtime source escaped its repository")
        files[relative] = digest(repository / relative, maximum=64 * 1024 * 1024)
    manifest = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"head": head, "files": files, "manifestSha256": manifest}


def sdk_version(log):
    if log.stat().st_size > 128 * 1024:
        raise ValueError("Flutter SDK metadata exceeds its byte bound")
    value = json.loads(log.read_text(encoding="utf-8"))
    if (not isinstance(value, dict) or value.get("frameworkRevision") != FLUTTER_HEAD or
            value.get("engineRevision") != ENGINE_HEAD or value.get("frameworkVersion") != "3.47.9"):
        raise ValueError("P106 requires the pinned Flutter 3.47.9/framework/engine")
    return {key: value.get(key) for key in ("frameworkVersion", "frameworkRevision", "engineRevision")}


def remaining(deadline, phase):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise TimeoutError("P106 overall deadline expired " + phase)
    return seconds


def run_step(command, *, repository, output, env, deadline, state, record):
    limit = remaining(deadline, "before launching a child")
    log = output / ("step-" + str(len(state["steps"])) + ".log")
    step = {"command": command, "started": time.time(), "log": str(log),
            "timeoutSeconds": limit, "exitCode": None}
    state["steps"].append(step)
    record()
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as target:
        process = subprocess.Popen(command, cwd=repository, env=env, stdin=subprocess.DEVNULL,
                                   stdout=target, stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        step["pid"] = process.pid
        try:
            record()
            code = process.wait(timeout=remaining(deadline, "while launching a child"))
        except BaseException:
            step["interrupted"] = True
            if process.poll() is None:
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=30, check=False)
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=30)
            raise
        finally:
            step.update(exitCode=process.returncode, finished=time.time())
            record()
    remaining(deadline, "after child completion")
    if code:
        # The child has exited; bounded excerpts may now be inspected.
        with log.open("rb") as source:
            source.seek(max(0, log.stat().st_size - 8192))
            tail = source.read(8192).decode("utf-8", errors="replace").splitlines()[-35:]
        raise RuntimeError("P106 child failed; completed log: " + str(log) + "\n" + "\n".join(tail))
    return log


def passed_capture(value):
    if (value.get("platform") != "windows" or value.get("qualification") != "bounded-windows-consumer-passed" or
            value.get("exitCode") != 0 or value.get("cpuReferenceRequested") is not True or
            value.get("consumerGpuCompletionVerified") is not False or
            value.get("hardwareAccelerationVerified") is not False or
            value.get("continuousPresentationSupported") is not False):
        raise ValueError("P106 actual legacy capture did not pass its bounded qualification")
    stages = value.get("stages")
    if not isinstance(stages, list) or len(stages) != 3:
        raise ValueError("P106 requires all three actual legacy publications")
    for index, stage in enumerate(stages, 1):
        if stage.get("stage", {}).get("index") != index:
            raise ValueError("P106 actual stage ordering is incomplete")
        comparison = stage.get("comparison", {})
        if (comparison.get("comparison") != "opaque-interiors-1-source-palette13-edge1px-zero-integer-shift" or
                comparison.get("sourceReferenceScale") not in (2, 3, 4)):
            raise ValueError("P106 independent CPU source reference was not used")
    result = value.get("result", {})
    closed, stats = result.get("closed", {}), result.get("stats", {})
    if result.get("ok") is not True or closed.get("ownerFinished") is not True or closed.get("unregistered") is not True:
        raise ValueError("P106 Native owner/unregister completion was not observed")
    if any(type(stats.get(key)) is not int or stats[key] != 0 for key in NATIVE_STATS):
        raise ValueError("P106 Native snapshot/frame/lease teardown did not return to zero")
    return {"publications": 3, "ownerFinished": True, "unregistered": True,
            "nativeStats": stats, "legacyLimitsAfterClose": closed.get("limits"),
            "comparisons": [stage["comparison"] for stage in stages]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("repository", "flutter-sdk", "native", "native-receipt", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--timeout", type=float, default=600)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.expected_head):
        parser.error("expected-head must be an exact lowercase 40-character source SHA")
    if not 30 <= args.timeout <= 600:
        parser.error("overall timeout must be 30..600 seconds")
    require_windows()
    repository = args.repository.resolve(strict=True)
    sdk = args.flutter_sdk.resolve(strict=True)
    native, native_receipt = args.native.resolve(strict=True), args.native_receipt.resolve(strict=True)
    output = args.output.resolve()
    try:
        output.relative_to(repository)
    except ValueError:
        pass
    else:
        raise ValueError("P106 build/capture output must be outside its source checkout")
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    receipt_path = output / "p106-windows-review.json"
    deadline = time.monotonic() + args.timeout
    state = {"platform": "windows", "sourceHead": args.expected_head, "qualification": "pending",
             "nativeRebuilt": False, "nativeSourceHead": NATIVE_HEAD, "nativeInputEquivalenceVerified": False,
             "consumerGpuCompletionVerified": False, "continuousPresentationSupported": False,
             "hardwareAccelerationVerified": False, "steps": [], "started": time.time(),
             "pid": os.getpid(), "timeoutSeconds": args.timeout}
    record = lambda: write_json(receipt_path, state)
    env = dict(os.environ, CI="true", FLUTTER_SUPPRESS_ANALYTICS="true",
               DART_SUPPRESS_ANALYTICS="true", FLUTTER_ROOT=str(sdk), PYTHONDONTWRITEBYTECODE="1")
    try:
        record()
        source = source_identity(repository, args.expected_head)
        state["runtimeSourceManifestSha256"] = source["manifestSha256"]
        state["runtimeSourceFiles"] = len(source["files"])
        seed = native_identity(native, read_json(native_receipt, limit=64 * 1024))
        receipt_hash = digest(native_receipt, maximum=64 * 1024)
        state["nativeSeed"] = seed
        dart, snapshot = sdk / "bin/cache/dart-sdk/bin/dart.exe", sdk / "bin/cache/flutter_tools.snapshot"
        if not dart.is_file() or not snapshot.is_file():
            raise ValueError("prepare the pinned Windows Flutter SDK/tool snapshot before P106 execution")
        tools = {"dartSha256": digest(dart), "snapshotSha256": digest(snapshot)}
        log = run_step([str(dart), "--disable-dart-dev", str(snapshot), "--version", "--machine"],
                       repository=repository, output=output, env=env, deadline=deadline, state=state, record=record)
        state["flutter"] = sdk_version(log)
        state["sdkTools"] = tools
        if source_identity(repository, args.expected_head) != source:
            raise ValueError("P106 source changed during SDK prewarm")
        build = output / "desktop-build"
        run_step([sys.executable, "-B", str(repository / "bindings/Flutter/tool/build_desktop_probe.py"),
                  "--flutter-sdk", str(sdk), "--native", str(native), "--native-receipt", str(native_receipt),
                  "--output", str(build)], repository=repository, output=output, env=env,
                 deadline=deadline, state=state, record=record)
        proof = read_json(build / "build-receipt.json")
        if (proof.get("buildExitCode") != 0 or proof.get("sourceHead") != args.expected_head or
                proof.get("nativeSourceHead") != NATIVE_HEAD or proof.get("sourceFiles") != source["files"] or
                proof.get("copiedRuntimeSources") != source["files"]):
            raise ValueError("P106 build did not preserve its exact source/native identities")
        artifacts = proof["artifacts"]
        if artifacts["native"]["sha256"] != NATIVE_SHA256:
            raise ValueError("P106 runner build received a different Native DLL")
        # The P106 legacy collector accepts at most 300 seconds. Its whole
        # capture/close/identity sequence remains under this driver's deadline.
        budget = min(300.0, remaining(deadline, "before consumer capture"))
        if budget < 10:
            raise TimeoutError("P106 overall deadline has no bounded capture budget remaining")
        capture = output / "desktop-capture"
        run_step([sys.executable, "-B", str(repository / "bindings/Flutter/tool/qualify_desktop_texture.py"),
                  "--runner", artifacts["runner"]["path"], "--native", artifacts["native"]["path"],
                  "--dispatcher", artifacts["dispatcher"]["path"], "--fixture", artifacts["fixture"]["path"],
                  "--build-receipt", str(build / "build-receipt.json"), "--cpu-reference",
                  "--timeout", str(budget), "--output", str(capture)], repository=repository,
                 output=output, env=env, deadline=deadline, state=state, record=record)
        result = passed_capture(read_json(capture / "receipt.json"))
        if source_identity(repository, args.expected_head) != source:
            raise ValueError("P106 source changed during actual consumer qualification")
        if native_identity(native, read_json(native_receipt, limit=64 * 1024)) != seed or digest(native_receipt) != receipt_hash:
            raise ValueError("P106 supplied Native artifact or original receipt changed")
        if tools != {"dartSha256": digest(dart), "snapshotSha256": digest(snapshot)}:
            raise ValueError("P106 Flutter SDK tool inputs changed during qualification")
        remaining(deadline, "during final source/SDK/Native identity checks")
        state.update(qualification="p106-actual-windows-legacy-passed", result=result,
                     buildReceipt=str(build / "build-receipt.json"), captureReceipt=str(capture / "receipt.json"),
                     sourceInputsStable=True, nativeInputsStable=True, sdkToolsStable=True, exitCode=0)
    except BaseException as error:
        state.update(qualification="failed", error=f"{type(error).__name__}: {error}", exitCode=1)
        raise
    finally:
        state["finished"] = time.time()
        record()
    print(receipt_path)


if __name__ == "__main__":
    main()
