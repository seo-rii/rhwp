use crate::paint::{CacheHint, RenderProfile};

use super::image_conv::ImageSampling;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct SkiaReplayPolicy {
    pub(super) image_sampling: ImageSampling,
    pub(super) vector_antialias: bool,
    pub(super) clip_antialias: bool,
    pub(super) prefer_direct_text: bool,
}

impl SkiaReplayPolicy {
    pub(super) fn for_state(
        profile: RenderProfile,
        prefer_raster: bool,
        prefer_vector: bool,
    ) -> Self {
        let image_sampling = if profile == RenderProfile::FastPreview || prefer_raster {
            ImageSampling::nearest()
        } else if matches!(profile, RenderProfile::Print | RenderProfile::HighQuality)
            || prefer_vector
        {
            ImageSampling::linear_mipmap()
        } else {
            ImageSampling::linear()
        };

        Self {
            image_sampling,
            vector_antialias: profile != RenderProfile::FastPreview || !prefer_raster,
            clip_antialias: profile != RenderProfile::FastPreview || !prefer_raster,
            prefer_direct_text: true,
        }
    }

    pub(super) fn from_cache_hints(profile: RenderProfile, cache_hints: &[CacheHint]) -> Self {
        Self::for_state(
            profile,
            cache_hints.contains(&CacheHint::PreferRaster),
            cache_hints.contains(&CacheHint::PreferVectorRecording),
        )
    }
}
