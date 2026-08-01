use crate::model::shape::TextWrap;
use crate::paint::{
    layer_tree::{LayerNode, LayerNodeKind},
    paint_op::PaintOp,
    text_v2::sidecars_for_leaf_ops,
};

/// Logical replay planes for PageLayerTree direct paint backends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PaintReplayPlane {
    Background,
    BehindText,
    Flow,
    InFrontOfText,
}

impl PaintReplayPlane {
    pub const ORDERED: [Self; 4] = [
        Self::Background,
        Self::BehindText,
        Self::Flow,
        Self::InFrontOfText,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Background => "background",
            Self::BehindText => "behindText",
            Self::Flow => "flow",
            Self::InFrontOfText => "inFrontOfText",
        }
    }
}

pub fn paint_op_replay_plane(op: &PaintOp) -> PaintReplayPlane {
    match op {
        PaintOp::PageBackground { .. } => PaintReplayPlane::Background,
        PaintOp::Image { image, .. } => match image.text_wrap {
            Some(TextWrap::BehindText) => PaintReplayPlane::BehindText,
            Some(TextWrap::InFrontOfText) => PaintReplayPlane::InFrontOfText,
            _ => PaintReplayPlane::Flow,
        },
        PaintOp::TextControlMark { mark, .. } => match mark.text_wrap {
            Some(TextWrap::BehindText) => PaintReplayPlane::BehindText,
            Some(TextWrap::InFrontOfText) => PaintReplayPlane::InFrontOfText,
            _ => PaintReplayPlane::Flow,
        },
        _ => PaintReplayPlane::Flow,
    }
}

pub fn layer_node_has_replay_plane(
    node: &LayerNode,
    sidecar_ops: &[PaintOp],
    replay_plane: PaintReplayPlane,
) -> bool {
    let mut stack = vec![node];
    while let Some(candidate) = stack.pop() {
        match &candidate.kind {
            LayerNodeKind::Group { children, .. } => {
                stack.extend(children.iter());
            }
            LayerNodeKind::ClipRect { child, .. } => {
                stack.push(child);
            }
            LayerNodeKind::Leaf { ops, .. } => {
                if ops
                    .iter()
                    .any(|op| paint_op_replay_plane(op) == replay_plane)
                    || sidecars_for_leaf_ops(ops, sidecar_ops)
                        .iter()
                        .any(|op| paint_op_replay_plane(op) == replay_plane)
                {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::image::ImageEffect;
    use crate::paint::{
        CacheHint, LayerImagePaint, LayerNode, LayerPageBackgroundPaint, LayerRectanglePaint,
        LayerSemantic, LayerTextControlMark, LayerTextControlMarkKind, LayerTextControlMarkPaint,
    };
    use crate::renderer::render_tree::{BoundingBox, ShapeTransform};
    use crate::renderer::ShapeStyle;

    fn bbox() -> BoundingBox {
        BoundingBox::new(0.0, 0.0, 10.0, 10.0)
    }

    fn image_with_wrap(wrap: Option<TextWrap>) -> PaintOp {
        PaintOp::Image {
            bbox: bbox(),
            image: LayerImagePaint {
                resource_id: None,
                external_path: None,
                text_wrap: wrap,
                fill_mode: None,
                original_size: None,
                crop: None,
                original_size_hu: None,
                brightness: 0,
                contrast: 0,
                effect: ImageEffect::RealPic,
                transform: ShapeTransform::default(),
            },
        }
    }

    fn control_mark_with_wrap(wrap: Option<TextWrap>) -> PaintOp {
        PaintOp::TextControlMark {
            bbox: bbox(),
            mark: LayerTextControlMarkPaint {
                source: None,
                text_wrap: wrap,
                mark: LayerTextControlMark {
                    kind: LayerTextControlMarkKind::Picture,
                    x: 0.0,
                    y: 10.0,
                    font_size: 10.0,
                },
            },
        }
    }

    #[test]
    fn ordered_planes_match_hwp_z_order_contract() {
        assert_eq!(
            PaintReplayPlane::ORDERED.map(PaintReplayPlane::as_str),
            ["background", "behindText", "flow", "inFrontOfText"]
        );
    }

    #[test]
    fn page_background_replays_on_background_plane() {
        let op = PaintOp::PageBackground {
            bbox: bbox(),
            background: LayerPageBackgroundPaint {
                background_color: None,
                border_color: None,
                border_width: 0.0,
                gradient: None,
                image: None,
            },
        };

        assert_eq!(paint_op_replay_plane(&op), PaintReplayPlane::Background);
    }

    #[test]
    fn behind_text_image_replays_before_flow() {
        let op = image_with_wrap(Some(TextWrap::BehindText));

        assert_eq!(paint_op_replay_plane(&op), PaintReplayPlane::BehindText);
    }

    #[test]
    fn in_front_of_text_image_replays_after_flow() {
        let op = image_with_wrap(Some(TextWrap::InFrontOfText));

        assert_eq!(paint_op_replay_plane(&op), PaintReplayPlane::InFrontOfText);
    }

    #[test]
    fn structure_control_mark_follows_owner_replay_plane() {
        assert_eq!(
            paint_op_replay_plane(&control_mark_with_wrap(Some(TextWrap::BehindText))),
            PaintReplayPlane::BehindText
        );
        assert_eq!(
            paint_op_replay_plane(&control_mark_with_wrap(Some(TextWrap::InFrontOfText))),
            PaintReplayPlane::InFrontOfText
        );
    }

    #[test]
    fn non_layered_control_mark_replays_on_flow_plane() {
        assert_eq!(
            paint_op_replay_plane(&control_mark_with_wrap(None)),
            PaintReplayPlane::Flow
        );
        assert_eq!(
            paint_op_replay_plane(&control_mark_with_wrap(Some(TextWrap::TopAndBottom))),
            PaintReplayPlane::Flow
        );
    }

    #[test]
    fn non_layered_ops_replay_on_flow_plane() {
        let plain_image = image_with_wrap(None);
        let top_and_bottom_image = image_with_wrap(Some(TextWrap::TopAndBottom));
        let vector = PaintOp::Rectangle {
            bbox: bbox(),
            rect: LayerRectanglePaint {
                corner_radius: 0.0,
                style: ShapeStyle::default(),
                gradient: None,
                transform: ShapeTransform::default(),
            },
        };

        assert_eq!(paint_op_replay_plane(&plain_image), PaintReplayPlane::Flow);
        assert_eq!(
            paint_op_replay_plane(&top_and_bottom_image),
            PaintReplayPlane::Flow
        );
        assert_eq!(paint_op_replay_plane(&vector), PaintReplayPlane::Flow);
    }

    #[test]
    fn layer_node_replay_plane_scan_descends_groups() {
        let child = LayerNode::leaf(
            bbox(),
            None,
            vec![image_with_wrap(Some(TextWrap::InFrontOfText))],
        );
        let group = LayerNode::group(
            bbox(),
            None,
            vec![child],
            CacheHint::None,
            LayerSemantic::default(),
        );

        assert!(layer_node_has_replay_plane(
            &group,
            &[],
            PaintReplayPlane::InFrontOfText
        ));
        assert!(!layer_node_has_replay_plane(
            &group,
            &[],
            PaintReplayPlane::BehindText
        ));
    }
}
