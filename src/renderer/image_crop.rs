/// Converts HWP/HWPX crop coordinates to decoded-image pixel coordinates.
///
/// `crop_reference_size` is the full `imgDim` coordinate range. Older HWP
/// payloads may not preserve it, so the crop right/bottom edges remain the
/// compatibility fallback. The fixed 75 HU/px scale is only used when neither
/// source provides a usable range.
pub(crate) fn compute_image_crop_src(
    crop: (i32, i32, i32, i32),
    crop_reference_size: Option<(u32, u32)>,
    image_width_px: f64,
    image_height_px: f64,
) -> (f64, f64, f64, f64) {
    let (left, top, right, bottom) = crop;
    const HU_PER_PX: f64 = 75.0;

    let (scale_x, scale_y) = crop_reference_size
        .filter(|(width, height)| {
            *width > 0
                && *height > 0
                && image_width_px.is_finite()
                && image_height_px.is_finite()
                && image_width_px > 0.0
                && image_height_px > 0.0
        })
        .map(|(width, height)| {
            (
                width as f64 / image_width_px,
                height as f64 / image_height_px,
            )
        })
        .filter(|(x, y)| x.is_finite() && y.is_finite() && *x > 0.0 && *y > 0.0)
        .or_else(|| {
            (right > 0
                && bottom > 0
                && image_width_px.is_finite()
                && image_height_px.is_finite()
                && image_width_px > 0.0
                && image_height_px > 0.0)
                .then(|| {
                    (
                        right as f64 / image_width_px,
                        bottom as f64 / image_height_px,
                    )
                })
                .filter(|(x, y)| x.is_finite() && y.is_finite() && *x > 0.0 && *y > 0.0)
        })
        .unwrap_or((HU_PER_PX, HU_PER_PX));

    (
        left as f64 / scale_x,
        top as f64 / scale_y,
        (right - left) as f64 / scale_x,
        (bottom - top) as f64 / scale_y,
    )
}

#[cfg(test)]
mod tests {
    use super::compute_image_crop_src;

    #[test]
    fn uses_img_dim_as_the_full_crop_coordinate_range() {
        assert_eq!(
            compute_image_crop_src((100, 100, 900, 700), Some((1000, 800)), 100.0, 80.0),
            (10.0, 10.0, 80.0, 60.0)
        );
    }

    #[test]
    fn uses_crop_edges_when_img_dim_is_unavailable() {
        assert_eq!(
            compute_image_crop_src((10, 20, 90, 100), None, 100.0, 80.0),
            (11.111_111_111_111_11, 16.0, 88.888_888_888_888_89, 64.0)
        );
    }

    #[test]
    fn uses_fixed_hwpunit_scale_only_without_a_coordinate_range() {
        assert_eq!(
            compute_image_crop_src((75, 150, 750, 900), None, f64::NAN, f64::NAN),
            (1.0, 2.0, 9.0, 10.0)
        );
    }
}
