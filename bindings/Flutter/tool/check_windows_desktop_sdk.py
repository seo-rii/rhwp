#!/usr/bin/env python3
"""Build and execute the pinned Windows desktop qualification on genuine Windows.

This is a validation command, without publish, secret, settings or deployment work.
Each child writes only to its owned log until it exits; fixed inputs stay pinned.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from qualify_desktop_texture import digest, require_actual_windows, write_json


def run_step(command, *, cwd, env, output, receipt, record, timeout=3600):
    index = len(receipt['steps'])
    log_path = output / f'step-{index}.log'
    step = {'command': command, 'cwd': str(cwd), 'started': time.time(),
            'exitCode': None, 'log': str(log_path), 'timeoutSeconds': timeout}
    receipt['steps'].append(step)
    record()
    with log_path.open('wb') as log:
        log_path.chmod(0o600)
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == 'win32' else 0
        process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
        step['pid'] = process.pid
        try:
            record()
            code = process.wait(timeout=timeout)
        except BaseException:
            step['interrupted'] = True
            if sys.platform == 'win32':
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=30, check=False)
            else:
                process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise
        finally:
            step.update(exitCode=process.returncode, finished=time.time())
            record()
    if code:
        # Read an excerpt only after the child has fully exited.
        tail = log_path.read_text(encoding='utf-8', errors='replace').splitlines()[-50:]
        raise RuntimeError('step failed: ' + str(log_path) + '\n' + '\n'.join(tail))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--flutter-sdk', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    require_actual_windows()
    repo = Path(__file__).resolve().parents[3]
    source_head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True):
        raise ValueError('the complete qualification source must be committed and clean')
    sdk = args.flutter_sdk.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    receipt_path = output / 'windows-sdk-receipt.json'
    state = {'platform': 'windows', 'source_head': source_head, 'steps': [], 'build': 'pending',
             'started': time.time(), 'pid': os.getpid(), 'consumerGpuCompletionVerified': False,
             'continuousPresentationSupported': False, 'hardwareAccelerationVerified': False}
    record = lambda: write_json(receipt_path, state)
    env = dict(os.environ, CARGO_TARGET_DIR=str(output / 'native-target'),
               CARGO_BUILD_BUILD_DIR=str(output / 'native-build'), CARGO_BUILD_JOBS='2',
               CARGO_INCREMENTAL='0', PYTHONDONTWRITEBYTECODE='1', CI='true',
               FLUTTER_SUPPRESS_ANALYTICS='true', DART_SUPPRESS_ANALYTICS='true')
    try:
        record()
        command = ['rustup', 'run', '1.93.1', 'cargo', 'build', '--locked', '--release',
                   '-p', 'rhwp-native-ffi', '--features', 'native-skia-d3d',
                   '--target', 'x86_64-pc-windows-msvc']
        run_step(command, cwd=repo, env=env, output=output, receipt=state, record=record,
                 timeout=5400)
        native = output / 'native-target/x86_64-pc-windows-msvc/release/rhwp_native_ffi.dll'
        native_receipt = output / 'native-build-receipt.json'
        write_json(native_receipt, {'source_head': source_head, 'build': 'passed',
                                   'artifacts': {'rhwp_native_ffi.dll': digest(native)}})
        build = output / 'desktop-build'
        run_step([sys.executable, '-B', str(repo / 'bindings/Flutter/tool/build_desktop_probe.py'),
                  '--flutter-sdk', str(sdk), '--native', str(native),
                  '--native-receipt', str(native_receipt), '--output', str(build)],
                 cwd=repo, env=env, output=output, receipt=state, record=record)
        proof = json.loads((build / 'build-receipt.json').read_text(encoding='utf-8'))
        artifacts = proof['artifacts']
        capture = output / 'desktop-capture'
        run_step([sys.executable, '-B', str(repo / 'bindings/Flutter/tool/qualify_desktop_texture.py'),
                  '--runner', artifacts['runner']['path'], '--native', artifacts['native']['path'],
                  '--dispatcher', artifacts['dispatcher']['path'],
                  '--fixture', artifacts['fixture']['path'],
                  '--build-receipt', str(build / 'build-receipt.json'), '--output', str(capture)],
                 cwd=repo, env=env, output=output, receipt=state, record=record, timeout=300)
        if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip() != source_head:
            raise ValueError('source head changed during qualification')
        if subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True):
            raise ValueError('source checkout changed during qualification')
        state.update(build='passed', native=str(native), nativeSha256=digest(native),
                     nativeReceipt=str(native_receipt), desktopCapture=str(capture),
                     boundedConsumerExecutionVerified=True)
    except BaseException as error:
        state.update(build='failed', error=f'{type(error).__name__}: {error}')
        raise
    finally:
        state['finished'] = time.time()
        record()
    print(receipt_path)


if __name__ == '__main__':
    main()
