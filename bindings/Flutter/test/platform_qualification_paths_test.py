#!/usr/bin/env python3
"""The validation router cannot omit unknown/common/native compiler inputs."""
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / 'tool/platform_qualification_paths.py'
spec = importlib.util.spec_from_file_location('qualification_paths', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
BOTH = {'windows', 'macos'}


class PathImpactContracts(unittest.TestCase):
    def check_paths(self, paths, expected):
        self.assertEqual(module.impact([{'filename': path} for path in paths]), expected)

    def test_macos_only_source_and_locator(self):
        self.check_paths(['bindings/Flutter/macos/Classes/MetalNativeView.hpp',
                          'bindings/Flutter/tool/find_macos_framework.py'], {'macos'})

    def test_windows_only_source_and_real_sdk_builder(self):
        self.check_paths(['bindings/Flutter/windows/Producer.cpp',
                          'bindings/Flutter/tool/check_windows_desktop_sdk.py'], {'windows'})

    def test_runtime_dart_probe_and_shared_pixel_contract_always_run_both(self):
        for path in ['bindings/Flutter/lib/src/native_texture_view.dart',
                     'bindings/Flutter/test/support/desktop_consumer_probe.dart',
                     'bindings/Flutter/tool/qualify_desktop_texture.py']:
            self.check_paths([path], BOTH)

    def test_rust_headers_vendor_embedded_assets_and_lock_run_both(self):
        for path in ['src/render_backend/skia_adapter.rs', 'bindings/Native/src/lib.rs',
                     'bindings/swift/Sources/CRhwpNative/rhwp_native_ffi.h',
                     'vendor/rhwp-jpeg-encoder/Cargo.toml', 'assets/fonts/example.otf',
                     'saved/blank2010.hwp', 'mydocs/manual/agent_feature_gate_policy.md',
                     'Cargo.lock', '.cargo/config.toml']:
            self.check_paths([path], BOTH)

    def test_workflow_or_classifier_change_revalidates_both(self):
        for path in ['.github/workflows/desktop-platform-qualification.yml',
                     'bindings/Flutter/tool/platform_qualification_paths.py']:
            self.check_paths([path], BOTH)

    def test_rename_checks_both_old_and_new_ownership(self):
        self.assertEqual(module.impact([{'status': 'renamed',
                         'filename': 'bindings/Flutter/macos/Classes/New.hpp',
                         'previous_filename': 'bindings/Flutter/windows/Old.h'}]), BOTH)

    def test_incomplete_malformed_or_truncated_comparison_runs_both(self):
        for data in [None, {}, [None], [{}], [{'filename': 1}],
                     [{'status': 'renamed', 'filename': 'bindings/Flutter/macos/a'}],
                     [{'filename': 'bindings/Flutter/macos/a'}] * 300]:
            self.assertEqual(module.impact(data), BOTH)

    def test_unknown_future_paths_run_both(self):
        self.check_paths(['future/compiler/input'], BOTH)

    def test_linux_backend_is_not_compiled_by_windows_or_macos(self):
        self.check_paths(['bindings/Flutter/linux/texture_state.cc'], set())


if __name__ == '__main__':
    unittest.main()
