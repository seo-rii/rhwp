//! Form control caption display helpers.
//!
//! HWPX stores form captions with UI-caption escaping semantics. Observed
//! Hancom output displays `&&` as one literal `&`, while storage and roundtrip
//! data must remain unchanged.

use std::borrow::Cow;

pub(crate) fn display_form_caption(caption: &str) -> Cow<'_, str> {
    let has_display_escape = caption.contains("&&");
    let has_xml_entity = caption.contains("&amp;")
        || caption.contains("&lt;")
        || caption.contains("&gt;")
        || caption.contains("&quot;")
        || caption.contains("&apos;");
    if !has_display_escape && !has_xml_entity {
        return Cow::Borrowed(caption);
    }

    let mut decoded = String::with_capacity(caption.len());
    let mut rest = caption;
    while !rest.is_empty() {
        if let Some(stripped) = rest.strip_prefix("&amp;") {
            decoded.push('&');
            rest = stripped;
        } else if let Some(stripped) = rest.strip_prefix("&lt;") {
            decoded.push('<');
            rest = stripped;
        } else if let Some(stripped) = rest.strip_prefix("&gt;") {
            decoded.push('>');
            rest = stripped;
        } else if let Some(stripped) = rest.strip_prefix("&quot;") {
            decoded.push('"');
            rest = stripped;
        } else if let Some(stripped) = rest.strip_prefix("&apos;") {
            decoded.push('\'');
            rest = stripped;
        } else {
            let ch = rest
                .chars()
                .next()
                .expect("non-empty caption remainder should have a char");
            decoded.push(ch);
            rest = &rest[ch.len_utf8()..];
        }
    }

    let mut out = String::with_capacity(decoded.len());
    let mut chars = decoded.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '&' && chars.peek() == Some(&'&') {
            chars.next();
            out.push('&');
        } else {
            out.push(ch);
        }
    }

    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::display_form_caption;
    use std::borrow::Cow;

    #[test]
    fn collapses_double_ampersand_for_form_caption_display() {
        assert_eq!(display_form_caption("R&&D"), "R&D");
        assert_eq!(display_form_caption("IP R&&D연계"), "IP R&D연계");
        assert_eq!(
            display_form_caption("R&&D 자율성트랙(일반)"),
            "R&D 자율성트랙(일반)"
        );
        assert_eq!(display_form_caption("&&&&"), "&&");
    }

    #[test]
    fn preserves_single_ampersand() {
        assert_eq!(display_form_caption("R&D"), "R&D");
        assert_eq!(display_form_caption("A&B&C"), "A&B&C");
    }

    #[test]
    fn decodes_xml_entities_before_display_escape() {
        assert_eq!(display_form_caption("R&amp;&amp;D"), "R&D");
        assert_eq!(display_form_caption("R&amp;D"), "R&D");
        assert_eq!(display_form_caption("&lt;R&amp;D&gt;"), "<R&D>");
    }

    #[test]
    fn borrows_when_no_display_escape_exists() {
        assert!(matches!(
            display_form_caption("plain caption"),
            Cow::Borrowed("plain caption")
        ));
    }
}
