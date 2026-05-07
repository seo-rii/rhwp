use skia_safe::Image;
use std::collections::HashMap;

use crate::model::image::ImageEffect;
use crate::paint::{CacheHint, ImageResourceId, LayerOutputOptions, RenderProfile, SvgResourceId};
use crate::renderer::layer_renderer::LayerRenderDiagnostics;

use super::cache::BoundedLruCache;
use super::image_conv::{
    decode_image_bytes, image_approx_rgba_bytes, preprocess_binary_image_effect,
    rasterize_svg_fragment, ImageDrawDiagnostics, ImageSampling,
};
use super::replay_policy::SkiaReplayPolicy;

pub(super) const MAX_IMAGE_EFFECT_CACHE_ENTRIES: usize = 64;
pub(super) const MAX_IMAGE_EFFECT_CACHE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) struct SvgResourceCacheKey {
    resource_id: SvgResourceId,
    width_bits: u32,
    height_bits: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) struct ImageEffectResourceCacheKey {
    // Native binary effect preprocessing is full-image and preserves the
    // source-image dither phase. A future crop-local path must include the
    // source rect and phase policy here.
    pub(super) resource_id: ImageResourceId,
    pub(super) effect_code: u8,
}

#[derive(Clone)]
pub(super) struct ImageEffectCacheEntry {
    image: Option<Image>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct SvgFragmentCacheKey {
    fragment_hash: u64,
    fragment_len: usize,
    width_bits: u32,
    height_bits: u32,
}

fn stable_hash_bytes(bytes: &[u8]) -> u64 {
    const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

    let mut hash = FNV_OFFSET_BASIS;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

pub(super) struct SkiaReplayContext {
    pub(super) profile: RenderProfile,
    pub(super) output_options: LayerOutputOptions,
    pub(super) scale: f64,
    replay_policy: SkiaReplayPolicy,
    pub(super) diagnostics: LayerRenderDiagnostics,
    cache_hints: Vec<CacheHint>,
    pub(super) image_cache: HashMap<ImageResourceId, Option<Image>>,
    pub(super) image_effect_cache:
        BoundedLruCache<ImageEffectResourceCacheKey, ImageEffectCacheEntry>,
    pub(super) svg_resource_cache: HashMap<SvgResourceCacheKey, Option<Image>>,
    pub(super) svg_fragment_cache: HashMap<SvgFragmentCacheKey, Option<Image>>,
}

impl SkiaReplayContext {
    pub(super) fn new(
        profile: RenderProfile,
        output_options: LayerOutputOptions,
        scale: f64,
    ) -> Self {
        Self {
            profile,
            output_options,
            scale,
            replay_policy: SkiaReplayPolicy::for_state(profile, false, false),
            diagnostics: LayerRenderDiagnostics::default(),
            cache_hints: Vec::new(),
            image_cache: HashMap::new(),
            image_effect_cache: BoundedLruCache::new(
                MAX_IMAGE_EFFECT_CACHE_ENTRIES,
                MAX_IMAGE_EFFECT_CACHE_BYTES,
            ),
            svg_resource_cache: HashMap::new(),
            svg_fragment_cache: HashMap::new(),
        }
    }

    pub(super) fn set_image_effect_cache_limits(
        &mut self,
        max_entries: usize,
        max_approx_bytes: usize,
    ) {
        let evictions = self
            .image_effect_cache
            .set_limits(max_entries, max_approx_bytes);
        self.diagnostics.image_effect_cache_evictions = self
            .diagnostics
            .image_effect_cache_evictions
            .saturating_add(evictions);
        self.diagnostics.image_effect_cache_approx_bytes = self.image_effect_cache.approx_bytes();
    }

    pub(super) fn push_cache_hint(&mut self, cache_hint: CacheHint) {
        self.cache_hints.push(cache_hint);
        self.refresh_replay_policy();
    }

    pub(super) fn pop_cache_hint(&mut self) {
        self.cache_hints.pop();
        self.refresh_replay_policy();
    }

    pub(super) fn record_image_draw(&mut self, diagnostics: ImageDrawDiagnostics) {
        self.diagnostics.tile_fallback_cap_hits = self
            .diagnostics
            .tile_fallback_cap_hits
            .saturating_add(diagnostics.tile_fallback_cap_hits);
        self.diagnostics.image_effect_preprocess_failures = self
            .diagnostics
            .image_effect_preprocess_failures
            .saturating_add(diagnostics.image_effect_preprocess_failures);
        self.diagnostics.image_effect_fallback_to_filter = self
            .diagnostics
            .image_effect_fallback_to_filter
            .saturating_add(diagnostics.image_effect_fallback_to_filter);
        self.diagnostics.image_effect_preprocessed_bytes = self
            .diagnostics
            .image_effect_preprocessed_bytes
            .saturating_add(diagnostics.image_effect_preprocessed_bytes);
    }

    pub(super) fn replay_policy(&self) -> SkiaReplayPolicy {
        self.replay_policy
    }

    fn refresh_replay_policy(&mut self) {
        self.replay_policy = SkiaReplayPolicy::from_cache_hints(self.profile, &self.cache_hints);
    }

    pub(super) fn image_sampling(&self) -> ImageSampling {
        self.replay_policy.image_sampling
    }

    pub(super) fn clip_antialias(&self) -> bool {
        self.replay_policy.clip_antialias
    }

    pub(super) fn prefer_direct_text(&self) -> bool {
        self.replay_policy.prefer_direct_text
    }

    pub(super) fn image_for_resource(
        &mut self,
        resource_id: ImageResourceId,
        bytes: &[u8],
    ) -> Option<Image> {
        if let Some(image) = self.image_cache.get(&resource_id) {
            return image.clone();
        }
        let image = decode_image_bytes(bytes);
        self.image_cache.insert(resource_id, image.clone());
        image
    }

    pub(super) fn binary_effect_image_for_resource(
        &mut self,
        resource_id: ImageResourceId,
        image: &Image,
        effect: ImageEffect,
    ) -> Option<Image> {
        let effect_code = match effect {
            ImageEffect::BlackWhite => 1,
            ImageEffect::Pattern8x8 => 2,
            _ => return None,
        };
        let key = ImageEffectResourceCacheKey {
            resource_id,
            effect_code,
        };
        if let Some(entry) = self.image_effect_cache.get_cloned(key) {
            let image = entry.image;
            self.diagnostics.image_effect_cache_hits =
                self.diagnostics.image_effect_cache_hits.saturating_add(1);
            self.diagnostics.image_effect_cache_approx_bytes =
                self.image_effect_cache.approx_bytes();
            return image;
        }

        self.diagnostics.image_effect_cache_misses =
            self.diagnostics.image_effect_cache_misses.saturating_add(1);
        let image = preprocess_binary_image_effect(image, effect);
        let approx_bytes = image.as_ref().map(image_approx_rgba_bytes).unwrap_or(0);
        self.diagnostics.image_effect_preprocessed_bytes = self
            .diagnostics
            .image_effect_preprocessed_bytes
            .saturating_add(approx_bytes);

        let outcome = self.image_effect_cache.insert(
            key,
            ImageEffectCacheEntry {
                image: image.clone(),
            },
            approx_bytes,
        );
        self.diagnostics.image_effect_cache_evictions = self
            .diagnostics
            .image_effect_cache_evictions
            .saturating_add(outcome.evictions);
        if outcome.skipped_oversized {
            self.diagnostics.image_effect_cache_skipped_oversized = self
                .diagnostics
                .image_effect_cache_skipped_oversized
                .saturating_add(1);
        }
        self.diagnostics.image_effect_cache_approx_bytes = self.image_effect_cache.approx_bytes();
        image
    }

    pub(super) fn svg_image_for_resource(
        &mut self,
        resource_id: SvgResourceId,
        fragment: &str,
        width: f32,
        height: f32,
    ) -> Option<Image> {
        let key = SvgResourceCacheKey {
            resource_id,
            width_bits: width.to_bits(),
            height_bits: height.to_bits(),
        };
        if let Some(image) = self.svg_resource_cache.get(&key) {
            return image.clone();
        }
        let image = rasterize_svg_fragment(fragment, width, height);
        self.svg_resource_cache.insert(key, image.clone());
        image
    }

    pub(super) fn svg_image_for_fragment(
        &mut self,
        fragment: &str,
        width: f32,
        height: f32,
    ) -> Option<Image> {
        let key = SvgFragmentCacheKey {
            fragment_hash: stable_hash_bytes(fragment.as_bytes()),
            fragment_len: fragment.len(),
            width_bits: width.to_bits(),
            height_bits: height.to_bits(),
        };
        if let Some(image) = self.svg_fragment_cache.get(&key) {
            return image.clone();
        }
        let image = rasterize_svg_fragment(fragment, width, height);
        self.svg_fragment_cache.insert(key, image.clone());
        image
    }
}
