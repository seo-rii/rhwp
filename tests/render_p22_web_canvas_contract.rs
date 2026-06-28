const WEB_CANVAS_SOURCE: &str = include_str!("../src/renderer/web_canvas.rs");

fn rust_body_after(source: &str, marker: &str) -> String {
    let method_start = source
        .find(marker)
        .unwrap_or_else(|| panic!("missing marker {marker:?}"));
    let method_open = source[method_start..]
        .find('{')
        .map(|offset| method_start + offset)
        .unwrap_or_else(|| panic!("missing body for marker {marker:?}"));

    let mut depth = 0usize;
    for (offset, ch) in source[method_open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return source[method_open..=method_open + offset].to_string();
                }
            }
            _ => {}
        }
    }

    panic!("unterminated body for marker {marker:?}");
}

#[test]
fn web_canvas_layer_leaf_replay_dispatches_paint_ops_directly() {
    let body = rust_body_after(WEB_CANVAS_SOURCE, "fn render_layer_node(");

    assert!(
        body.contains("LayerNodeKind::Leaf"),
        "render_layer_node should handle leaf nodes directly"
    );
    assert!(
        body.contains("for op in ops"),
        "leaf replay should iterate layer PaintOps"
    );
    assert!(
        body.contains("PaintOp::"),
        "leaf replay should dispatch PaintOp payloads directly"
    );
    assert!(
        !body.contains("RenderNode::new"),
        "layer replay must not rebuild temporary RenderNode wrappers"
    );
    assert!(
        !body.contains("render_node("),
        "layer replay must not fall back to legacy RenderNode replay"
    );
}

#[test]
fn web_canvas_layer_tree_replays_logical_planes_in_order() {
    let render_layer_tree =
        rust_body_after(WEB_CANVAS_SOURCE, "pub fn render_layer_tree(&mut self");
    let render_layer_node = rust_body_after(WEB_CANVAS_SOURCE, "fn render_layer_node(");

    assert!(
        WEB_CANVAS_SOURCE.contains("active_replay_plane: Option<PaintReplayPlane>"),
        "WebCanvasRenderer should track the currently replayed logical plane"
    );
    assert!(
        render_layer_tree.contains("for replay_plane in PaintReplayPlane::ORDERED"),
        "PageLayerTree direct replay should follow the shared HWP z-order plane ordering"
    );
    assert!(
        render_layer_tree
            .contains("layer_node_has_replay_plane(&tree.root, &tree.variant_ops, replay_plane)"),
        "WebCanvas should skip empty planes using root ops plus text variant sidecars"
    );
    assert!(
        render_layer_tree.contains("self.active_replay_plane = Some(replay_plane)"),
        "render_layer_tree should publish the active plane before descending into the tree"
    );
    assert!(
        render_layer_node.contains("paint_op_replay_plane(op) != active_replay_plane"),
        "leaf replay should filter PaintOps to the active logical plane"
    );
}
