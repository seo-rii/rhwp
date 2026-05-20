//! SVG fragment utilities used by RawSvg render nodes.

/// Extracts a simple `attr="..."` value from an SVG fragment.
///
/// This intentionally only supports the simple quoted attributes emitted by
/// rhwp's OLE/EMF/OOXML SVG producers.
pub(crate) fn find_svg_attr_value<'a>(s: &'a str, attr: &str) -> Option<&'a str> {
    let needle = format!("{}=\"", attr);
    let mut search_from = 0;
    while let Some(idx) = s[search_from..].find(&needle) {
        let pos = search_from + idx;
        let is_boundary = if pos == 0 {
            false
        } else {
            let prev = s.as_bytes()[pos - 1];
            matches!(prev, b' ' | b'\t' | b'\n' | b'\r')
        };
        if !is_boundary {
            search_from = pos + needle.len();
            continue;
        }
        let value_start = pos + needle.len();
        let end = s[value_start..].find('"')?;
        return Some(&s[value_start..value_start + end]);
    }
    None
}

/// Extracts a data URL from a single `<image .../>` SVG fragment.
pub(crate) fn try_parse_single_image_data_url(svg: &str) -> Option<&str> {
    let s = svg.trim();
    if !s.starts_with("<image") || !s.ends_with("/>") {
        return None;
    }
    if s.matches('<').count() != 1 {
        return None;
    }
    let href = find_svg_attr_value(s, "xlink:href").or_else(|| find_svg_attr_value(s, "href"))?;
    if !href.starts_with("data:") {
        return None;
    }
    Some(href)
}

/// Detects whether bytes look like an SVG document prefix.
pub(crate) fn is_svg_prefix(data: &[u8]) -> bool {
    let mut i = 0;
    while i < data.len().min(64) && matches!(data[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    if data.len().saturating_sub(i) < 4 {
        return false;
    }
    if data[i..].starts_with(b"<svg") {
        return true;
    }
    if data[i..].starts_with(b"<?xml") {
        let search_end = data.len().min(i + 256);
        return data[i..search_end].windows(4).any(|w| w == b"<svg");
    }
    false
}

/// Wraps a page-absolute SVG fragment in a complete SVG document.
pub(crate) fn wrap_svg_fragment(fragment: &str, x: f64, y: f64, w: f64, h: f64) -> String {
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" \
         width=\"{w:.3}\" height=\"{h:.3}\" viewBox=\"{x:.3} {y:.3} {w:.3} {h:.3}\">\n{fragment}\n</svg>"
    )
}

/// Decodes a base64 data URL and returns `(mime, bytes)`.
pub(crate) fn decode_base64_data_url(data_url: &str) -> Option<(String, Vec<u8>)> {
    use base64::Engine;

    let rest = data_url.strip_prefix("data:")?;
    let comma = rest.find(',')?;
    let header = &rest[..comma];
    let payload = &rest[comma + 1..];
    let (mime, is_base64) = if let Some(m) = header.strip_suffix(";base64") {
        (m, true)
    } else {
        (header, false)
    };
    if !is_base64 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    Some((mime.to_string(), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_attr_uses_word_boundary() {
        let s = r#"<image xlink:href="data:A" href="data:B"/>"#;
        assert_eq!(find_svg_attr_value(s, "href"), Some("data:B"));
        assert_eq!(find_svg_attr_value(s, "xlink:href"), Some("data:A"));
    }

    #[test]
    fn parse_single_image_data_url() {
        let frag = r#"<image x="10.50" y="20.75" width="100.00" height="50.00" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/png;base64,AAAA" href="data:image/png;base64,AAAA"/>"#;
        assert_eq!(
            try_parse_single_image_data_url(frag),
            Some("data:image/png;base64,AAAA")
        );
    }

    #[test]
    fn parse_single_image_rejects_composite_svg() {
        let g_emf =
            r#"<g transform="matrix(1,0,0,1,0,0)"><rect x="0" y="0" width="10" height="10"/></g>"#;
        assert_eq!(try_parse_single_image_data_url(g_emf), None);
    }

    #[test]
    fn decode_data_url_png() {
        let url = "data:image/png;base64,iVBORw0KGgo=";
        let (mime, bytes) = decode_base64_data_url(url).expect("decode");
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }

    #[test]
    fn is_svg_prefix_accepts_svg_documents() {
        assert!(is_svg_prefix(b"<svg"));
        assert!(is_svg_prefix(b"  \n  <svg>"));
        assert!(is_svg_prefix(b"<?xml version=\"1.0\"?>\n<svg>"));
    }

    #[test]
    fn is_svg_prefix_rejects_raster_images() {
        assert!(!is_svg_prefix(b"\x89PNG\r\n\x1a\n"));
        assert!(!is_svg_prefix(b"\xFF\xD8\xFF"));
        assert!(!is_svg_prefix(b"BM"));
    }

    #[test]
    fn wrap_svg_fragment_preserves_content_and_viewbox() {
        let frag = r#"<text x="5" y="5">가 &amp; 나</text>"#;
        let wrapped = wrap_svg_fragment(frag, 100.0, 200.0, 300.0, 400.0);
        assert!(wrapped.contains("xmlns:xlink=\"http://www.w3.org/1999/xlink\""));
        assert!(wrapped.contains("viewBox=\"100.000 200.000 300.000 400.000\""));
        assert!(wrapped.contains(frag));
    }
}
