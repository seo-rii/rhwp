use crate::paint::{
    FontPortabilityKind, GlyphRunReplayEligibility, LayerNode, LayerNodeKind, LayerTextRunPaint,
    PaintOp, TextClusterFlag,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontRequest {
    pub family: String,
    pub bold: bool,
    pub italic: bool,
}

impl From<&LayerTextRunPaint> for FontRequest {
    fn from(run: &LayerTextRunPaint) -> Self {
        Self {
            family: run.style.font_family.clone(),
            bold: run.style.bold,
            italic: run.style.italic,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedFontFace {
    pub portability: FontPortabilityKind,
}

pub trait FontResolver {
    fn resolve_font(&self, request: &FontRequest) -> ResolvedFontFace;
}

#[derive(Debug, Default)]
pub struct NoopFontResolver;

impl FontResolver for NoopFontResolver {
    fn resolve_font(&self, _request: &FontRequest) -> ResolvedFontFace {
        ResolvedFontFace {
            portability: FontPortabilityKind::UnresolvedFallback,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphRunQuality {
    Exact,
    PositionAdjusted,
    Approximate,
    DiagnosticOnly,
    Omitted,
}

impl GlyphRunQuality {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::PositionAdjusted => "positionAdjusted",
            Self::Approximate => "approximate",
            Self::DiagnosticOnly => "diagnosticOnly",
            Self::Omitted => "omitted",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextShapeDiagnostic {
    pub text: String,
    pub attempted: bool,
    pub public_glyph_run_emitted: bool,
    pub quality: GlyphRunQuality,
    pub replay_eligibility: GlyphRunReplayEligibility,
    pub strict_visual_eligible: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TextShapeReport {
    pub diagnostics: Vec<TextShapeDiagnostic>,
}

impl TextShapeReport {
    pub fn public_glyph_run_count(&self) -> usize {
        self.diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.public_glyph_run_emitted)
            .count()
    }
}

pub struct TextShapeLowerer<'a> {
    resolver: &'a dyn FontResolver,
}

impl<'a> TextShapeLowerer<'a> {
    pub fn new(resolver: &'a dyn FontResolver) -> Self {
        Self { resolver }
    }

    pub fn diagnostics_only(resolver: &'a dyn FontResolver) -> Self {
        Self::new(resolver)
    }

    pub fn analyze_root(&self, root: &LayerNode) -> TextShapeReport {
        let mut report = TextShapeReport::default();
        self.collect_node(root, &mut report);
        report
    }

    fn collect_node(&self, node: &LayerNode, report: &mut TextShapeReport) {
        match &node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    self.collect_node(child, report);
                }
            }
            LayerNodeKind::ClipRect { child, .. } => self.collect_node(child, report),
            LayerNodeKind::Leaf { ops, .. } => {
                for op in ops {
                    if let PaintOp::TextRun { run, .. } = op {
                        report.diagnostics.push(self.analyze_text_run(run));
                    }
                }
            }
        }
    }

    fn analyze_text_run(&self, run: &LayerTextRunPaint) -> TextShapeDiagnostic {
        let has_source = run.source.is_some();
        let excluded_by_cluster = run.clusters.iter().any(|cluster| {
            cluster
                .flags
                .iter()
                .any(|flag| *flag == TextClusterFlag::NotShapingCandidate)
        });
        let excluded_by_legacy_visual = run.char_overlap.is_some()
            || run
                .legacy_visuals
                .char_overlap
                .is_some_and(|state| state == crate::paint::TextLegacyVisualState::Mirror);

        if !has_source {
            return TextShapeDiagnostic {
                text: run.text.clone(),
                attempted: false,
                public_glyph_run_emitted: false,
                quality: GlyphRunQuality::Omitted,
                replay_eligibility: GlyphRunReplayEligibility::NotReplayable,
                strict_visual_eligible: false,
                reason: Some("missingSourceSpan".to_string()),
            };
        }

        if excluded_by_cluster || excluded_by_legacy_visual {
            return TextShapeDiagnostic {
                text: run.text.clone(),
                attempted: false,
                public_glyph_run_emitted: false,
                quality: GlyphRunQuality::Omitted,
                replay_eligibility: GlyphRunReplayEligibility::NotReplayable,
                strict_visual_eligible: false,
                reason: Some("notShapingCandidate".to_string()),
            };
        }

        let request = FontRequest::from(run);
        let resolved = self.resolver.resolve_font(&request);
        let replay_eligibility = GlyphRunReplayEligibility::from(resolved.portability);
        let attempted = matches!(
            replay_eligibility,
            GlyphRunReplayEligibility::Portable
                | GlyphRunReplayEligibility::ConditionalExternalFont
                | GlyphRunReplayEligibility::LocalDiagnosticOnly
        );
        let quality = if attempted {
            GlyphRunQuality::DiagnosticOnly
        } else {
            GlyphRunQuality::Omitted
        };
        let reason = match replay_eligibility {
            GlyphRunReplayEligibility::Portable => Some("diagnosticsOnlySkeleton".to_string()),
            GlyphRunReplayEligibility::ConditionalExternalFont => {
                Some("externalFontRequiresConsumerVerification".to_string())
            }
            GlyphRunReplayEligibility::LocalDiagnosticOnly => {
                Some("localDiagnosticOnly".to_string())
            }
            GlyphRunReplayEligibility::NotReplayable => Some("fontResourceUnavailable".to_string()),
        };

        TextShapeDiagnostic {
            text: run.text.clone(),
            attempted,
            public_glyph_run_emitted: false,
            quality,
            replay_eligibility,
            strict_visual_eligible: false,
            reason,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::{
        LayerNode, LayerTextRunPaint, TextSourceId, TextSourceRange, TextSourceSpan,
    };
    use crate::renderer::render_tree::BoundingBox;

    struct PortableResolver;

    impl FontResolver for PortableResolver {
        fn resolve_font(&self, _request: &FontRequest) -> ResolvedFontFace {
            ResolvedFontFace {
                portability: FontPortabilityKind::PortableBlob,
            }
        }
    }

    #[test]
    fn diagnostics_only_lowerer_never_emits_public_glyph_runs() {
        let run = LayerTextRunPaint {
            source: Some(TextSourceSpan {
                id: TextSourceId(0),
                utf8_range: TextSourceRange::new(0, 3),
                utf16_range: TextSourceRange::new(0, 1),
                stable_source_key: None,
            }),
            text: "가".to_string(),
            ..LayerTextRunPaint::default()
        };
        let root = LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, 100.0, 100.0),
            None,
            vec![PaintOp::TextRun {
                bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
                run,
            }],
        );
        let lowerer = TextShapeLowerer::diagnostics_only(&PortableResolver);
        let report = lowerer.analyze_root(&root);

        assert_eq!(report.public_glyph_run_count(), 0);
        assert_eq!(report.diagnostics.len(), 1);
        assert!(report.diagnostics[0].attempted);
        assert_eq!(
            report.diagnostics[0].replay_eligibility,
            GlyphRunReplayEligibility::Portable
        );
        assert_eq!(
            report.diagnostics[0].quality,
            GlyphRunQuality::DiagnosticOnly
        );
    }

    #[test]
    fn diagnostics_only_lowerer_excludes_text_without_source() {
        let run = LayerTextRunPaint {
            text: "A".to_string(),
            ..LayerTextRunPaint::default()
        };
        let root = LayerNode::leaf(
            BoundingBox::new(0.0, 0.0, 100.0, 100.0),
            None,
            vec![PaintOp::TextRun {
                bbox: BoundingBox::new(0.0, 0.0, 20.0, 20.0),
                run,
            }],
        );
        let lowerer = TextShapeLowerer::diagnostics_only(&PortableResolver);
        let report = lowerer.analyze_root(&root);

        assert_eq!(report.diagnostics[0].quality, GlyphRunQuality::Omitted);
        assert_eq!(
            report.diagnostics[0].reason.as_deref(),
            Some("missingSourceSpan")
        );
    }
}
