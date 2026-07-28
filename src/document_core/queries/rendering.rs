//! 렌더링/페이지 정보/구성/페이지네이션/페이지 트리 관련 native 메서드

use super::super::helpers::color_ref_to_css;
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::document::Section;
use crate::model::page::ColumnDef;
use crate::model::paragraph::Paragraph;
use crate::paint::{
    resolve_embedded_font_face_index, EmbeddedFontFace, LayerBuilder, LayerOutputOptions,
    PageLayerTree, RenderProfile, TextFontSlot,
};
use crate::renderer::canvas::CanvasRenderer;
use crate::renderer::composer::{compose_paragraph, compose_section, ComposedParagraph};
use crate::renderer::height_measurer::{HeightMeasurer, MeasuredSection, MeasuredTable};
use crate::renderer::html::HtmlRenderer;
use crate::renderer::layer_renderer::{LayerRasterRenderer, LayerRenderer};
use crate::renderer::layout::LayoutEngine;
use crate::renderer::page_layout::PageLayoutInfo;
use crate::renderer::pagination::{PaginationResult, Paginator};
use crate::renderer::render_tree::PageRenderTree;
#[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
use crate::renderer::skia::SkiaLayerRenderer;
use crate::renderer::style_resolver::resolve_styles;
use crate::renderer::svg::SvgRenderer;
use crate::renderer::svg_layer::SvgLayerRenderer;
use std::cell::RefCell;

const MAX_EMBEDDED_FONT_SOURCE_BYTES: usize = 32 * 1024 * 1024;
const MAX_PAGE_EMBEDDED_FONT_SOURCE_BYTES: usize = 64 * 1024 * 1024;
const MAX_PAGE_EMBEDDED_FONT_FACES: usize = 64;

struct LoadedEmbeddedFontFace {
    slot: TextFontSlot,
    family: String,
    alternate_family: Option<String>,
    bytes: std::sync::Arc<[u8]>,
    face_index: u32,
}

impl LoadedEmbeddedFontFace {
    fn borrowed(&self) -> EmbeddedFontFace<'_> {
        EmbeddedFontFace {
            char_shape_id: self.slot.char_shape_id,
            language_index: usize::from(self.slot.language_index),
            family: &self.family,
            alternate_family: self.alternate_family.as_deref(),
            bytes: &self.bytes,
            face_index: self.face_index,
        }
    }
}

impl DocumentCore {
    fn build_page_tree_for_output(&self, page_num: u32) -> Result<PageRenderTree, HwpError> {
        let tree = self.build_page_tree(page_num)?;
        let _overflows = self.layout_engine.take_overflows();
        Ok(tree)
    }

    pub(crate) fn build_page_layer_tree_for_output(
        &self,
        page_num: u32,
        default_profile: RenderProfile,
    ) -> Result<PageLayerTree, HwpError> {
        self.build_page_layer_tree_cached(
            page_num,
            self.resolve_layer_render_profile(default_profile),
        )
    }

    fn build_layer_tree_from_page_tree(
        &self,
        tree: &PageRenderTree,
        profile: RenderProfile,
    ) -> PageLayerTree {
        let output_options = LayerOutputOptions {
            show_paragraph_marks: self.show_paragraph_marks,
            show_control_codes: self.show_control_codes,
            show_transparent_borders: self.show_transparent_borders,
            clip_enabled: self.clip_enabled,
            debug_overlay: self.debug_overlay,
        };
        let mut builder = LayerBuilder::new(profile).with_output_options(output_options);
        let loaded_fonts = self.load_page_embedded_fonts(tree);
        let embedded_fonts = loaded_fonts
            .iter()
            .map(LoadedEmbeddedFontFace::borrowed)
            .collect::<Vec<_>>();
        builder.build_with_embedded_fonts(tree, &embedded_fonts)
    }

    fn load_page_embedded_fonts(&self, tree: &PageRenderTree) -> Vec<LoadedEmbeddedFontFace> {
        let mut font_candidates = Vec::new();
        let mut seen_slots = std::collections::HashSet::new();
        let mut pending = vec![&tree.root];
        while let Some(node) = pending.pop() {
            if !node.visible {
                continue;
            }
            if let crate::renderer::render_tree::RenderNodeType::TextRun(run) = &node.node_type {
                let mut characters = run.text.chars();
                if characters.next().is_some() && characters.next().is_none() {
                    if let Some(slot) = run.char_shape_id.zip(run.style.font_language_index).map(
                        |(char_shape_id, language_index)| TextFontSlot {
                            char_shape_id,
                            language_index,
                        },
                    ) {
                        if seen_slots.insert(slot) {
                            let language_index = usize::from(slot.language_index);
                            let font_id = self
                                .document
                                .doc_info
                                .char_shapes
                                .get(slot.char_shape_id as usize)
                                .and_then(|char_shape| {
                                    char_shape.font_ids.get(language_index).copied()
                                })
                                .map(usize::from);
                            if let Some(font_id) = font_id {
                                let is_embedded = self
                                    .document
                                    .doc_info
                                    .font_faces
                                    .get(language_index)
                                    .and_then(|fonts| fonts.get(font_id))
                                    .is_some_and(|font| {
                                        font.is_embedded && font.resolved_bin_data_id.is_some()
                                    });
                                if is_embedded {
                                    font_candidates.push((slot, language_index, font_id));
                                    if font_candidates.len() >= MAX_PAGE_EMBEDDED_FONT_FACES {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            pending.extend(node.children.iter().rev());
        }

        let mut loaded_bytes = std::collections::HashMap::<u16, std::sync::Arc<[u8]>>::new();
        let mut total_source_bytes = 0usize;
        let mut loaded_faces = Vec::new();
        for (slot, language_index, font_id) in font_candidates {
            let Some(font) = self
                .document
                .doc_info
                .font_faces
                .get(language_index)
                .and_then(|fonts| fonts.get(font_id))
            else {
                continue;
            };
            if !font.is_embedded {
                continue;
            }
            let Some(bin_data_id) = font.resolved_bin_data_id else {
                continue;
            };
            let bytes = if let Some(bytes) = loaded_bytes.get(&bin_data_id) {
                std::sync::Arc::clone(bytes)
            } else {
                let remaining = MAX_PAGE_EMBEDDED_FONT_SOURCE_BYTES
                    .saturating_sub(total_source_bytes)
                    .min(MAX_EMBEDDED_FONT_SOURCE_BYTES);
                if remaining == 0 {
                    continue;
                }
                let Some(content) = crate::renderer::layout::find_bin_data(
                    &self.document.bin_data_content,
                    bin_data_id,
                ) else {
                    continue;
                };
                let Some(bytes) = content.data.load_limited(remaining) else {
                    continue;
                };
                if bytes.is_empty() {
                    continue;
                }
                let Some(next_total) = total_source_bytes.checked_add(bytes.len()) else {
                    continue;
                };
                if next_total > MAX_PAGE_EMBEDDED_FONT_SOURCE_BYTES {
                    continue;
                }
                total_source_bytes = next_total;
                let bytes = std::sync::Arc::<[u8]>::from(bytes);
                loaded_bytes.insert(bin_data_id, std::sync::Arc::clone(&bytes));
                bytes
            };
            let alternate_family = font.alt_name.clone().or_else(|| font.default_name.clone());
            let Some(face_index) =
                resolve_embedded_font_face_index(&bytes, &font.name, alternate_family.as_deref())
            else {
                continue;
            };
            loaded_faces.push(LoadedEmbeddedFontFace {
                slot,
                family: font.name.clone(),
                alternate_family,
                bytes,
                face_index,
            });
        }
        loaded_faces
    }

    fn resolve_layer_render_profile(&self, default_profile: RenderProfile) -> RenderProfile {
        std::env::var("RHWP_RENDER_PROFILE")
            .ok()
            .as_deref()
            .and_then(RenderProfile::parse_name)
            .unwrap_or(default_profile)
    }

    fn configure_svg_renderer(&self, renderer: &mut SvgRenderer) {
        renderer.show_paragraph_marks = self.show_paragraph_marks;
        renderer.show_control_codes = self.show_control_codes;
        renderer.debug_overlay = self.debug_overlay;
    }

    pub fn render_page_svg_native(&self, page_num: u32) -> Result<String, HwpError> {
        if matches!(
            std::env::var("RHWP_RENDER_PATH").ok().as_deref(),
            Some("layer-svg")
        ) {
            return self.render_page_svg_layer_native(page_num);
        }
        self.render_page_svg_legacy_native(page_num)
    }

    pub fn render_page_svg_legacy_native(&self, page_num: u32) -> Result<String, HwpError> {
        let tree = self.build_page_tree_for_output(page_num)?;
        let mut renderer = SvgRenderer::new();
        self.configure_svg_renderer(&mut renderer);
        renderer.render_tree(&tree);
        Ok(renderer.output().to_string())
    }

    pub fn render_page_svg_layer_native(&self, page_num: u32) -> Result<String, HwpError> {
        let layer_tree = self.build_page_layer_tree_for_output(page_num, RenderProfile::Print)?;
        let mut renderer = SvgLayerRenderer::new();
        renderer.configure_output(
            self.show_paragraph_marks,
            self.show_control_codes,
            self.debug_overlay,
        );
        renderer
            .render_page(&layer_tree)
            .map_err(|err| HwpError::RenderError(err.to_string()))?;
        Ok(renderer.output().to_string())
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn render_page_pdf_native(&self, page_num: u32) -> Result<Vec<u8>, HwpError> {
        self.render_pages_pdf_native(&[page_num])
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn render_pages_pdf_native(&self, pages: &[u32]) -> Result<Vec<u8>, HwpError> {
        if pages.is_empty() {
            return Err(HwpError::RenderError(
                "PDF export requires at least one page".to_string(),
            ));
        }

        let mut svg_pages = Vec::with_capacity(pages.len());
        for &page_num in pages {
            svg_pages.push(self.render_page_svg_native(page_num)?);
        }

        crate::renderer::pdf::svgs_to_pdf(&svg_pages)
            .map_err(|err| HwpError::RenderError(err.to_string()))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn render_document_pdf_native(&self) -> Result<Vec<u8>, HwpError> {
        let pages: Vec<u32> = (0..self.page_count()).collect();
        self.render_pages_pdf_native(&pages)
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    pub fn render_page_png_native(&self, page_num: u32) -> Result<Vec<u8>, HwpError> {
        self.render_page_png_native_with_fonts(page_num, &[])
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
    pub fn render_page_png_native_with_fonts(
        &self,
        page_num: u32,
        font_paths: &[std::path::PathBuf],
    ) -> Result<Vec<u8>, HwpError> {
        let layer_tree =
            self.build_page_layer_tree_for_output(page_num, RenderProfile::HighQuality)?;
        let renderer = SkiaLayerRenderer::new().with_font_paths(font_paths);
        LayerRasterRenderer::render_png(&renderer, &layer_tree)
            .map_err(|err| HwpError::RenderError(err.to_string()))
    }

    /// SVG 렌더링 (폰트 임베딩 옵션 포함)
    #[cfg(not(target_arch = "wasm32"))]
    pub fn render_page_svg_with_fonts(
        &self,
        page_num: u32,
        font_embed_mode: crate::renderer::svg::FontEmbedMode,
        font_paths: &[std::path::PathBuf],
    ) -> Result<String, HwpError> {
        if matches!(
            std::env::var("RHWP_RENDER_PATH").ok().as_deref(),
            Some("layer-svg")
        ) {
            let tree = self.build_page_tree_for_output(page_num)?;
            let layer_tree = self.build_page_layer_tree_cached(
                page_num,
                self.resolve_layer_render_profile(RenderProfile::Print),
            )?;

            let mut layer_renderer = SvgLayerRenderer::new();
            layer_renderer.configure_output(
                self.show_paragraph_marks,
                self.show_control_codes,
                self.debug_overlay,
            );
            layer_renderer
                .render_page(&layer_tree)
                .map_err(|err| HwpError::RenderError(err.to_string()))?;

            let mut collector = SvgRenderer::new();
            self.configure_svg_renderer(&mut collector);
            collector.font_embed_mode = font_embed_mode;
            collector.font_paths = font_paths.to_vec();
            collector.render_tree(&tree);

            let mut svg = layer_renderer.output().to_string();
            if font_embed_mode != crate::renderer::svg::FontEmbedMode::None {
                let style_css = crate::renderer::svg::generate_font_style(&collector, font_paths);
                if !style_css.is_empty() {
                    if let Some(pos) = svg.find('>') {
                        let insert = format!("\n<style>\n{}</style>\n", style_css);
                        svg.insert_str(pos + 1, &insert);
                    }
                }
            }
            return Ok(svg);
        }

        let tree = self.build_page_tree_for_output(page_num)?;
        let mut renderer = SvgRenderer::new();
        self.configure_svg_renderer(&mut renderer);
        renderer.font_embed_mode = font_embed_mode;
        renderer.font_paths = font_paths.to_vec();
        renderer.render_tree(&tree);

        // 폰트 임베딩 후처리
        let mut svg = renderer.output().to_string();
        if font_embed_mode != crate::renderer::svg::FontEmbedMode::None {
            let style_css = crate::renderer::svg::generate_font_style(&renderer, font_paths);
            if !style_css.is_empty() {
                // <svg ...> 직후에 <style> 삽입
                if let Some(pos) = svg.find('>') {
                    let insert = format!("\n<style>\n{}</style>\n", style_css);
                    svg.insert_str(pos + 1, &insert);
                }
            }
        }
        Ok(svg)
    }

    /// HTML 렌더링 (네이티브 에러 타입)
    pub fn render_page_html_native(&self, page_num: u32) -> Result<String, HwpError> {
        let tree = self.build_page_tree_for_output(page_num)?;
        let mut renderer = HtmlRenderer::new();
        renderer.show_paragraph_marks = self.show_paragraph_marks;
        renderer.show_control_codes = self.show_control_codes;
        renderer.render_tree(&tree);
        Ok(renderer.output().to_string())
    }

    /// Canvas 렌더링 (네이티브 에러 타입)
    pub fn render_page_canvas_native(&self, page_num: u32) -> Result<u32, HwpError> {
        let tree = self.build_page_tree_for_output(page_num)?;
        let mut renderer = CanvasRenderer::new();
        renderer.render_tree(&tree);
        Ok(renderer.command_count() as u32)
    }

    pub fn get_canvaskit_replay_plan_native(
        &self,
        page_num: u32,
        mode: &str,
    ) -> Result<String, HwpError> {
        use crate::renderer::canvaskit_policy::{
            analyze_canvaskit_replay_plan, CanvasKitReplayMode,
        };

        let mode = CanvasKitReplayMode::from_str(mode).ok_or_else(|| {
            HwpError::RenderError(format!(
                "지원하지 않는 CanvasKit replay mode입니다: {mode}. allowed modes: default, compat"
            ))
        })?;
        let tree = self.build_page_layer_tree_for_output(page_num, RenderProfile::Screen)?;
        let plan = analyze_canvaskit_replay_plan(&tree, mode);
        Ok(plan.to_json())
    }

    pub fn get_canvaskit_document_preflight_native(
        &self,
        mode: &str,
        profile: RenderProfile,
    ) -> Result<String, HwpError> {
        use crate::renderer::canvaskit_policy::{
            analyze_canvaskit_document_preflight, estimate_canvaskit_page_lowering_work,
            CanvasKitBoundedWorkCount, CanvasKitPreflightPageBuild, CanvasKitReplayMode,
        };

        let mode = CanvasKitReplayMode::from_str(mode).ok_or_else(|| {
            HwpError::RenderError(format!(
                "지원하지 않는 CanvasKit replay mode입니다: {mode}. allowed modes: default, compat"
            ))
        })?;
        let preflight = analyze_canvaskit_document_preflight(
            self.page_count(),
            mode,
            profile,
            |page_index, remaining_work_units| -> Result<CanvasKitPreflightPageBuild, HwpError> {
                let page = self.with_page_tree_cached(page_index, |tree| {
                    let CanvasKitBoundedWorkCount::Complete(prelower_work_units) =
                        estimate_canvaskit_page_lowering_work(tree, remaining_work_units)
                    else {
                        return Ok(CanvasKitPreflightPageBuild::WorkLimitExceeded);
                    };
                    Ok(CanvasKitPreflightPageBuild::Complete {
                        tree: Box::new(self.build_layer_tree_from_page_tree(tree, profile)),
                        prelower_work_units,
                    })
                })?;
                let _overflows = self.layout_engine.take_overflows();
                Ok(page)
            },
        );
        Ok(preflight.to_json())
    }

    pub fn get_page_layer_tree_native(&self, page_num: u32) -> Result<String, HwpError> {
        let layer_tree = self.build_page_layer_tree_for_output(page_num, RenderProfile::Screen)?;
        Ok(layer_tree.to_json())
    }

    pub fn get_page_layer_tree_with_profile_native(
        &self,
        page_num: u32,
        profile: RenderProfile,
    ) -> Result<String, HwpError> {
        let layer_tree = self.build_page_layer_tree_cached(page_num, profile)?;
        Ok(layer_tree.to_json())
    }

    /// 페이지 정보 (네이티브 에러 타입)
    pub fn get_page_info_native(&self, page_num: u32) -> Result<String, HwpError> {
        use crate::renderer::hwpunit_to_px;
        let (page_content, _, _) = self.find_page(page_num)?;
        let sec_idx = page_content.section_index;
        let page_def = &self.document.sections[sec_idx].section_def.page_def;
        let ml = hwpunit_to_px(page_def.margin_left as i32, self.dpi);
        let mr = hwpunit_to_px(page_def.margin_right as i32, self.dpi);
        let mt = hwpunit_to_px(page_def.margin_top as i32, self.dpi);
        let mb = hwpunit_to_px(page_def.margin_bottom as i32, self.dpi);
        let mh = hwpunit_to_px(page_def.margin_header as i32, self.dpi);
        let mf = hwpunit_to_px(page_def.margin_footer as i32, self.dpi);
        // 단별 영역 정보
        let cols_json: String = page_content
            .layout
            .column_areas
            .iter()
            .map(|ca| format!("{{\"x\":{:.1},\"width\":{:.1}}}", ca.x, ca.width))
            .collect::<Vec<_>>()
            .join(",");
        Ok(format!(
            "{{\"pageIndex\":{},\"width\":{:.1},\"height\":{:.1},\"sectionIndex\":{},\
            \"marginLeft\":{:.1},\"marginRight\":{:.1},\"marginTop\":{:.1},\"marginBottom\":{:.1},\
            \"marginHeader\":{:.1},\"marginFooter\":{:.1},\"columns\":[{}]}}",
            page_content.page_index,
            page_content.layout.page_width,
            page_content.layout.page_height,
            page_content.section_index,
            ml,
            mr,
            mt,
            mb,
            mh,
            mf,
            cols_json,
        ))
    }

    /// 구역 정의(SectionDef)를 JSON으로 반환 (네이티브 에러 타입)
    pub fn get_section_def_native(&self, section_idx: usize) -> Result<String, HwpError> {
        let section = self
            .document
            .sections
            .get(section_idx)
            .ok_or_else(|| HwpError::RenderError(format!("구역 {} 범위 초과", section_idx)))?;
        let sd = &section.section_def;
        Ok(format!(
            "{{\"pageNum\":{},\"pageNumType\":{},\"pictureNum\":{},\"tableNum\":{},\"equationNum\":{},\
            \"columnSpacing\":{},\"defaultTabSpacing\":{},\
            \"hideHeader\":{},\"hideFooter\":{},\"hideMasterPage\":{},\
            \"hideBorder\":{},\"hideFill\":{},\"hideEmptyLine\":{}}}",
            sd.page_num, sd.page_num_type,
            sd.picture_num, sd.table_num, sd.equation_num,
            sd.column_spacing, sd.default_tab_spacing,
            sd.hide_header, sd.hide_footer, sd.hide_master_page,
            sd.hide_border, sd.hide_fill, sd.hide_empty_line,
        ))
    }

    /// 단일 구역의 SectionDef 필드를 JSON에서 업데이트 (재조판 없이)
    fn apply_section_def_json(&mut self, section_idx: usize, json: &str) -> Result<(), HwpError> {
        use super::super::helpers::{json_bool, json_u16, json_u32};

        let section = self
            .document
            .sections
            .get_mut(section_idx)
            .ok_or_else(|| HwpError::RenderError(format!("구역 {} 범위 초과", section_idx)))?;
        let sd = &mut section.section_def;

        if let Some(v) = json_u16(json, "pageNum") {
            sd.page_num = v;
        }
        if let Some(v) = json_u16(json, "pageNumType") {
            sd.page_num_type = v as u8;
        }
        if let Some(v) = json_u16(json, "pictureNum") {
            sd.picture_num = v;
        }
        if let Some(v) = json_u16(json, "tableNum") {
            sd.table_num = v;
        }
        if let Some(v) = json_u16(json, "equationNum") {
            sd.equation_num = v;
        }
        if let Some(v) = json_u16(json, "columnSpacing") {
            sd.column_spacing = v as i16;
        }
        if let Some(v) = json_u32(json, "defaultTabSpacing") {
            sd.default_tab_spacing = v;
        }
        if let Some(v) = json_bool(json, "hideHeader") {
            sd.hide_header = v;
        }
        if let Some(v) = json_bool(json, "hideFooter") {
            sd.hide_footer = v;
        }
        if let Some(v) = json_bool(json, "hideMasterPage") {
            sd.hide_master_page = v;
        }
        if let Some(v) = json_bool(json, "hideBorder") {
            sd.hide_border = v;
        }
        if let Some(v) = json_bool(json, "hideFill") {
            sd.hide_fill = v;
        }
        if let Some(v) = json_bool(json, "hideEmptyLine") {
            sd.hide_empty_line = v;
        }

        // flags 비트플래그 재구성 (파서와 동일한 비트 위치)
        let flags = &mut sd.flags;
        fn set_bit(flags: &mut u32, mask: u32, val: bool) {
            if val {
                *flags |= mask;
            } else {
                *flags &= !mask;
            }
        }
        set_bit(flags, 0x0100, sd.hide_header); // bit 8
        set_bit(flags, 0x0200, sd.hide_footer); // bit 9
        set_bit(flags, 0x0400, sd.hide_master_page); // bit 10
        set_bit(flags, 0x0800, sd.hide_border); // bit 11
        set_bit(flags, 0x1000, sd.hide_fill); // bit 12
        set_bit(flags, 0x00080000, sd.hide_empty_line); // bit 19
                                                        // bit 20-21: 쪽 번호 종류
        *flags &= !0x00300000; // clear bits 20-21
        *flags |= ((sd.page_num_type as u32) & 0x03) << 20;

        // paragraphs[0]의 Control::SectionDef에도 동기화
        let updated_sd = section.section_def.clone();
        if let Some(para) = section.paragraphs.get_mut(0) {
            for ctrl in &mut para.controls {
                if let Control::SectionDef(ref mut s) = ctrl {
                    s.page_num = updated_sd.page_num;
                    s.page_num_type = updated_sd.page_num_type;
                    s.picture_num = updated_sd.picture_num;
                    s.table_num = updated_sd.table_num;
                    s.equation_num = updated_sd.equation_num;
                    s.column_spacing = updated_sd.column_spacing;
                    s.default_tab_spacing = updated_sd.default_tab_spacing;
                    s.hide_header = updated_sd.hide_header;
                    s.hide_footer = updated_sd.hide_footer;
                    s.hide_master_page = updated_sd.hide_master_page;
                    s.hide_border = updated_sd.hide_border;
                    s.hide_fill = updated_sd.hide_fill;
                    s.hide_empty_line = updated_sd.hide_empty_line;
                    s.flags = updated_sd.flags;
                    break;
                }
            }
        }

        // raw_stream 무효화
        section.raw_stream = None;
        Ok(())
    }

    /// 재조판 + 재페이지네이션 수행
    fn recompose_and_paginate(&mut self) -> u32 {
        self.composed = self
            .document
            .sections
            .iter()
            .map(|s| compose_section(s))
            .collect();
        self.mark_all_sections_dirty();
        self.paginate();
        self.page_count()
    }

    /// 구역 정의(SectionDef)를 변경하고 재페이지네이션 (네이티브 에러 타입)
    pub fn set_section_def_native(
        &mut self,
        section_idx: usize,
        json: &str,
    ) -> Result<String, HwpError> {
        self.apply_section_def_json(section_idx, json)?;
        let page_count = self.recompose_and_paginate();
        Ok(format!("{{\"ok\":true,\"pageCount\":{}}}", page_count))
    }

    /// 모든 구역의 SectionDef를 일괄 변경하고 재페이지네이션 (네이티브 에러 타입)
    pub fn set_section_def_all_native(&mut self, json: &str) -> Result<String, HwpError> {
        let count = self.document.sections.len();
        for idx in 0..count {
            self.apply_section_def_json(idx, json)?;
        }
        let page_count = self.recompose_and_paginate();
        Ok(format!("{{\"ok\":true,\"pageCount\":{}}}", page_count))
    }

    /// 구역의 용지 설정(PageDef)을 HWPUNIT 원본값으로 반환 (네이티브 에러 타입)
    pub fn get_page_def_native(&self, section_idx: usize) -> Result<String, HwpError> {
        let section = self
            .document
            .sections
            .get(section_idx)
            .ok_or_else(|| HwpError::RenderError(format!("구역 {} 범위 초과", section_idx)))?;
        let pd = &section.section_def.page_def;
        let binding: u8 = match pd.binding {
            crate::model::page::BindingMethod::SingleSided => 0,
            crate::model::page::BindingMethod::DuplexSided => 1,
            crate::model::page::BindingMethod::TopFlip => 2,
        };
        Ok(format!(
            "{{\"width\":{},\"height\":{},\
            \"marginLeft\":{},\"marginRight\":{},\"marginTop\":{},\"marginBottom\":{},\
            \"marginHeader\":{},\"marginFooter\":{},\"marginGutter\":{},\
            \"landscape\":{},\"binding\":{}}}",
            pd.width,
            pd.height,
            pd.margin_left,
            pd.margin_right,
            pd.margin_top,
            pd.margin_bottom,
            pd.margin_header,
            pd.margin_footer,
            pd.margin_gutter,
            pd.landscape,
            binding,
        ))
    }

    /// 구역의 용지 설정(PageDef)을 변경하고 재페이지네이션 (네이티브 에러 타입)
    pub fn set_page_def_native(
        &mut self,
        section_idx: usize,
        json: &str,
    ) -> Result<String, HwpError> {
        use crate::model::page::BindingMethod;

        let section = self
            .document
            .sections
            .get_mut(section_idx)
            .ok_or_else(|| HwpError::RenderError(format!("구역 {} 범위 초과", section_idx)))?;
        let pd = &mut section.section_def.page_def;

        use super::super::helpers::{json_bool, json_u32};

        if let Some(v) = json_u32(json, "width") {
            pd.width = v;
        }
        if let Some(v) = json_u32(json, "height") {
            pd.height = v;
        }
        if let Some(v) = json_u32(json, "marginLeft") {
            pd.margin_left = v;
        }
        if let Some(v) = json_u32(json, "marginRight") {
            pd.margin_right = v;
        }
        if let Some(v) = json_u32(json, "marginTop") {
            pd.margin_top = v;
        }
        if let Some(v) = json_u32(json, "marginBottom") {
            pd.margin_bottom = v;
        }
        if let Some(v) = json_u32(json, "marginHeader") {
            pd.margin_header = v;
        }
        if let Some(v) = json_u32(json, "marginFooter") {
            pd.margin_footer = v;
        }
        if let Some(v) = json_u32(json, "marginGutter") {
            pd.margin_gutter = v;
        }
        if let Some(v) = json_bool(json, "landscape") {
            pd.landscape = v;
        }
        if let Some(v) = json_u32(json, "binding") {
            pd.binding = match v {
                1 => BindingMethod::DuplexSided,
                2 => BindingMethod::TopFlip,
                _ => BindingMethod::SingleSided,
            };
        }

        // FIX 1: attr 비트플래그 재구성 (bit 0 = landscape, bit 1-2 = binding)
        pd.attr = (pd.attr & !0x07)
            | (if pd.landscape { 1 } else { 0 })
            | (match pd.binding {
                BindingMethod::SingleSided => 0u32,
                BindingMethod::DuplexSided => 1u32 << 1,
                BindingMethod::TopFlip => 2u32 << 1,
            });

        // FIX 2: paragraphs[0]의 Control::SectionDef에도 page_def 동기화
        let updated_page_def = section.section_def.page_def.clone();
        if let Some(para) = section.paragraphs.get_mut(0) {
            for ctrl in &mut para.controls {
                if let Control::SectionDef(ref mut sd) = ctrl {
                    sd.page_def = updated_page_def;
                    break;
                }
            }
        }

        // FIX 3: raw_stream 무효화 → 직렬화 시 모델에서 재구성
        section.raw_stream = None;

        // 재조판 + 재페이지네이션
        self.composed = self
            .document
            .sections
            .iter()
            .map(|s| compose_section(s))
            .collect();
        self.mark_all_sections_dirty();
        self.paginate();

        let page_count = self.page_count();
        Ok(format!("{{\"ok\":true,\"pageCount\":{}}}", page_count))
    }

    /// 텍스트 레이아웃 정보 (네이티브 에러 타입)
    pub fn get_page_text_layout_native(&self, page_num: u32) -> Result<String, HwpError> {
        use crate::renderer::layout::compute_char_positions;
        use crate::renderer::render_tree::{RenderNode, RenderNodeType};

        let tree = self.build_page_tree(page_num)?;

        // 렌더 트리에서 TextRun 노드를 재귀적으로 수집
        fn collect_text_runs(node: &RenderNode, runs: &mut Vec<String>) {
            if let RenderNodeType::TextRun(ref text_run) = node.node_type {
                let positions = compute_char_positions(&text_run.text, &text_run.style);
                let char_x: Vec<String> = positions.iter().map(|v| format!("{:.1}", v)).collect();

                let escaped_text = super::super::helpers::json_escape(&text_run.text);

                // 문서 좌표 (편집용)
                let doc_coords = match (
                    text_run.section_index,
                    text_run.para_index,
                    text_run.char_start,
                ) {
                    (Some(si), Some(pi), Some(cs)) => {
                        format!(",\"secIdx\":{},\"paraIdx\":{},\"charStart\":{}", si, pi, cs)
                    }
                    _ => String::new(),
                };

                // 표 셀 식별 정보 (편집용)
                let cell_coords = if let Some(ref ctx) = text_run.cell_context {
                    let outer = &ctx.path[0];
                    let path_entries: Vec<String> = ctx
                        .path
                        .iter()
                        .map(|e| {
                            format!(
                                "{{\"controlIndex\":{},\"cellIndex\":{},\"cellParaIndex\":{}}}",
                                e.control_index, e.cell_index, e.cell_para_index
                            )
                        })
                        .collect();
                    format!(",\"parentParaIdx\":{},\"controlIdx\":{},\"cellIdx\":{},\"cellParaIdx\":{},\"cellPath\":[{}]",
                        ctx.parent_para_index, outer.control_index, outer.cell_index, outer.cell_para_index,
                        path_entries.join(","))
                } else {
                    String::new()
                };

                let escaped_font = super::super::helpers::json_escape(&text_run.style.font_family);
                let font_info = format!(
                    ",\"fontFamily\":\"{}\",\"fontSize\":{:.1},\"bold\":{},\"italic\":{},\"ratio\":{:.2},\"letterSpacing\":{:.1}",
                    escaped_font,
                    text_run.style.font_size,
                    text_run.style.bold,
                    text_run.style.italic,
                    text_run.style.ratio,
                    text_run.style.letter_spacing,
                );

                // 서식 툴바용 추가 속성
                let format_info = format!(
                    ",\"underline\":{},\"strikethrough\":{},\"textColor\":\"{}\"",
                    !matches!(
                        text_run.style.underline,
                        crate::model::style::UnderlineType::None
                    ),
                    text_run.style.strikethrough,
                    color_ref_to_css(text_run.style.color),
                );

                // 글자/문단 모양 ID (서식 툴바용)
                let shape_ids = match (text_run.char_shape_id, text_run.para_shape_id) {
                    (Some(csid), Some(psid)) => {
                        format!(",\"charShapeId\":{},\"paraShapeId\":{}", csid, psid)
                    }
                    (Some(csid), None) => format!(",\"charShapeId\":{}", csid),
                    (None, Some(psid)) => format!(",\"paraShapeId\":{}", psid),
                    _ => String::new(),
                };

                runs.push(format!(
                    "{{\"text\":\"{}\",\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1},\"charX\":[{}]{}{}{}{}{}}}",
                    escaped_text,
                    node.bbox.x,
                    node.bbox.y,
                    node.bbox.width,
                    node.bbox.height,
                    char_x.join(","),
                    font_info,
                    format_info,
                    shape_ids,
                    doc_coords,
                    cell_coords,
                ));
            }
            for child in &node.children {
                collect_text_runs(child, runs);
            }
        }

        let mut runs = Vec::new();
        collect_text_runs(&tree.root, &mut runs);

        Ok(format!("{{\"runs\":[{}]}}", runs.join(",")))
    }

    /// 컨트롤(표, 이미지 등) 레이아웃 정보 (네이티브 에러 타입)
    pub fn get_page_control_layout_native(&self, page_num: u32) -> Result<String, HwpError> {
        use crate::renderer::render_tree::{RenderNode, RenderNodeType};

        let tree = self.build_page_tree_cached(page_num)?;

        // 렌더 트리에서 Table, Image 노드를 재귀적으로 수집
        fn collect_controls(node: &RenderNode, controls: &mut Vec<String>) {
            match &node.node_type {
                RenderNodeType::Table(table_node) => {
                    // 문서 좌표
                    let doc_coords = match (
                        table_node.section_index,
                        table_node.para_index,
                        table_node.control_index,
                    ) {
                        (Some(si), Some(pi), Some(ci)) => {
                            format!(
                                ",\"secIdx\":{},\"paraIdx\":{},\"controlIdx\":{}",
                                si, pi, ci
                            )
                        }
                        _ => String::new(),
                    };

                    // 셀 정보 수집
                    let mut cells = Vec::new();
                    for (cell_idx, child) in node.children.iter().enumerate() {
                        if let RenderNodeType::TableCell(cell_node) = &child.node_type {
                            cells.push(format!(
                                "{{\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1},\"row\":{},\"col\":{},\"rowSpan\":{},\"colSpan\":{},\"cellIdx\":{}}}",
                                child.bbox.x, child.bbox.y, child.bbox.width, child.bbox.height,
                                cell_node.row, cell_node.col, cell_node.row_span, cell_node.col_span,
                                cell_idx
                            ));
                        }
                    }

                    controls.push(format!(
                        "{{\"type\":\"table\",\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1},\"rowCount\":{},\"colCount\":{}{},\"cells\":[{}]}}",
                        node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height,
                        table_node.row_count, table_node.col_count,
                        doc_coords,
                        cells.join(",")
                    ));
                    // Table 내부도 탐색 (셀 내 수식 등 수집)
                }
                RenderNodeType::Equation(eq_node) => {
                    let doc_coords = match (
                        eq_node.section_index,
                        eq_node.para_index,
                        eq_node.control_index,
                    ) {
                        (Some(si), Some(pi), Some(ci)) => {
                            format!(
                                ",\"secIdx\":{},\"paraIdx\":{},\"controlIdx\":{}",
                                si, pi, ci
                            )
                        }
                        _ => String::new(),
                    };
                    let cell_coords = match (eq_node.cell_index, eq_node.cell_para_index) {
                        (Some(ci), Some(cpi)) => {
                            format!(",\"cellIdx\":{},\"cellParaIdx\":{}", ci, cpi)
                        }
                        _ => String::new(),
                    };

                    controls.push(format!(
                        "{{\"type\":\"equation\",\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1}{}{}}}",
                        node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height,
                        doc_coords, cell_coords
                    ));
                    return;
                }
                RenderNodeType::Image(image_node) => {
                    let doc_coords = match (
                        image_node.section_index,
                        image_node.para_index,
                        image_node.control_index,
                    ) {
                        (Some(si), Some(pi), Some(ci)) => {
                            format!(
                                ",\"secIdx\":{},\"paraIdx\":{},\"controlIdx\":{}",
                                si, pi, ci
                            )
                        }
                        _ => String::new(),
                    };

                    controls.push(format!(
                        "{{\"type\":\"image\",\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1}{}}}",
                        node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height, doc_coords
                    ));
                    return;
                }
                RenderNodeType::Group(group_node) => {
                    if let (Some(si), Some(pi), Some(ci)) = (
                        group_node.section_index,
                        group_node.para_index,
                        group_node.control_index,
                    ) {
                        controls.push(format!(
                            "{{\"type\":\"group\",\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1},\"secIdx\":{},\"paraIdx\":{},\"controlIdx\":{}}}",
                            node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height,
                            si, pi, ci
                        ));
                        return; // 자식 개별 수집하지 않음 — 묶음 전체가 하나의 컨트롤
                    }
                }
                RenderNodeType::Rectangle(rect_node) => {
                    // 문서 좌표가 있는 Rectangle만 shape로 수집 (배경 사각형 제외)
                    if let (Some(si), Some(pi), Some(ci)) = (
                        rect_node.section_index,
                        rect_node.para_index,
                        rect_node.control_index,
                    ) {
                        controls.push(format!(
                            "{{\"type\":\"shape\",\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1},\"secIdx\":{},\"paraIdx\":{},\"controlIdx\":{}}}",
                            node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height,
                            si, pi, ci
                        ));
                        return;
                    }
                }
                RenderNodeType::Line(line_node) => {
                    if let (Some(si), Some(pi), Some(ci)) = (
                        line_node.section_index,
                        line_node.para_index,
                        line_node.control_index,
                    ) {
                        controls.push(format!(
                            "{{\"type\":\"line\",\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1},\"x1\":{:.1},\"y1\":{:.1},\"x2\":{:.1},\"y2\":{:.1},\"secIdx\":{},\"paraIdx\":{},\"controlIdx\":{}}}",
                            node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height,
                            line_node.x1, line_node.y1, line_node.x2, line_node.y2,
                            si, pi, ci
                        ));
                        return;
                    }
                }
                RenderNodeType::Ellipse(ell_node) => {
                    if let (Some(si), Some(pi), Some(ci)) = (
                        ell_node.section_index,
                        ell_node.para_index,
                        ell_node.control_index,
                    ) {
                        controls.push(format!(
                            "{{\"type\":\"shape\",\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1},\"secIdx\":{},\"paraIdx\":{},\"controlIdx\":{}}}",
                            node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height,
                            si, pi, ci
                        ));
                        return;
                    }
                }
                RenderNodeType::Path(path_node) => {
                    if let (Some(si), Some(pi), Some(ci)) = (
                        path_node.section_index,
                        path_node.para_index,
                        path_node.control_index,
                    ) {
                        if let Some((x1, y1, x2, y2)) = path_node.connector_endpoints {
                            // 연결선: 선 선택 방식 (시작/끝 좌표 포함)
                            controls.push(format!(
                                "{{\"type\":\"line\",\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1},\"x1\":{:.1},\"y1\":{:.1},\"x2\":{:.1},\"y2\":{:.1},\"secIdx\":{},\"paraIdx\":{},\"controlIdx\":{}}}",
                                node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height,
                                x1, y1, x2, y2,
                                si, pi, ci
                            ));
                        } else {
                            controls.push(format!(
                                "{{\"type\":\"shape\",\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1},\"secIdx\":{},\"paraIdx\":{},\"controlIdx\":{}}}",
                                node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height,
                                si, pi, ci
                            ));
                        }
                        return;
                    }
                }
                _ => {}
            }
            for child in &node.children {
                collect_controls(child, controls);
            }
        }

        let mut controls = Vec::new();
        collect_controls(&tree.root, &mut controls);

        Ok(format!("{{\"controls\":[{}]}}", controls.join(",")))
    }

    /// 구역의 문단들에서 초기 ColumnDef를 추출한다.
    pub(crate) fn find_initial_column_def(paragraphs: &[Paragraph]) -> ColumnDef {
        for para in paragraphs {
            for ctrl in &para.controls {
                if let Control::ColumnDef(cd) = ctrl {
                    return cd.clone();
                }
            }
        }
        ColumnDef::default()
    }

    /// 특정 문단에 적용되는 ColumnDef를 찾는다.
    /// 문단 순서대로 탐색하여 para_idx 이하에서 가장 마지막 ColumnDef를 반환한다.
    /// (한 구역 내에서 다단↔단일단 전환이 여러 번 일어날 수 있음)
    pub(crate) fn find_column_def_for_paragraph(
        paragraphs: &[Paragraph],
        para_idx: usize,
    ) -> ColumnDef {
        let mut last_cd = ColumnDef::default();
        for (i, para) in paragraphs.iter().enumerate() {
            if i > para_idx {
                break;
            }
            for ctrl in &para.controls {
                if let Control::ColumnDef(cd) = ctrl {
                    last_cd = cd.clone();
                }
            }
        }
        last_cd
    }

    /// 구역을 재조판하고 dirty로 표시한다.
    pub(crate) fn recompose_section(&mut self, section_idx: usize) {
        self.invalidate_page_tree_cache();
        self.composed[section_idx] = compose_section(&self.document.sections[section_idx]);
        if section_idx < self.dirty_sections.len() {
            self.dirty_sections[section_idx] = true;
        }
        // 전체 문단 dirty (모두 재측정 필요)
        if section_idx < self.dirty_paragraphs.len() {
            self.dirty_paragraphs[section_idx] = None;
        }
    }

    /// 구역을 dirty로 표시만 한다 (재조판 없이).
    /// 셀 내부 편집처럼 composed 데이터가 불변인 경우 사용.
    pub(crate) fn mark_section_dirty(&mut self, section_idx: usize) {
        if section_idx < self.dirty_sections.len() {
            self.dirty_sections[section_idx] = true;
        }
        // 문단 dirty는 건드리지 않음 (셀 편집 시 문단 재측정 불필요)
    }

    /// 문단 dirty 비트 설정
    pub(crate) fn mark_paragraph_dirty(&mut self, section_idx: usize, para_idx: usize) {
        if section_idx >= self.dirty_paragraphs.len() {
            return;
        }
        let para_count = self.document.sections[section_idx].paragraphs.len();
        match &mut self.dirty_paragraphs[section_idx] {
            None => {
                // 전체 dirty 상태에서 선택적으로 전환:
                // 전체 dirty인데 특정 문단만 dirty로 설정하면 안 됨 → 이미 전체 dirty이므로 유지
                // (이 경우는 recompose_section 후 recompose_paragraph 호출 시 발생 불가)
            }
            Some(bits) => {
                bits.resize(para_count, false);
                if para_idx < bits.len() {
                    bits[para_idx] = true;
                }
            }
        }
    }

    /// 단일 문단만 재조판한다.
    pub(crate) fn recompose_paragraph(&mut self, section_idx: usize, para_idx: usize) {
        self.invalidate_page_tree_cache();
        let para = &self.document.sections[section_idx].paragraphs[para_idx];
        self.composed[section_idx][para_idx] = compose_paragraph(para);
        self.mark_section_dirty(section_idx);
        self.mark_paragraph_dirty(section_idx, para_idx);
    }

    /// composed 벡터에 새 문단 항목을 삽입한다 (문단 분할/붙여넣기 후).
    pub(crate) fn insert_composed_paragraph(&mut self, section_idx: usize, para_idx: usize) {
        self.invalidate_page_tree_cache();
        let para = &self.document.sections[section_idx].paragraphs[para_idx];
        let composed = compose_paragraph(para);
        self.composed[section_idx].insert(para_idx, composed);
        self.mark_section_dirty(section_idx);
        // measured_sections: 인덱스 조정으로 기존 측정값 재사용 (전체 재측정 회피)
        if section_idx < self.measured_sections.len() {
            self.measured_sections[section_idx].shift_for_insert(para_idx);
        }
        // dirty_paragraphs: 삽입된 문단과 분할 원본만 dirty 표시
        if section_idx < self.dirty_paragraphs.len() {
            let para_count = self.document.sections[section_idx].paragraphs.len();
            let bits =
                self.dirty_paragraphs[section_idx].get_or_insert_with(|| vec![false; para_count]);
            // 기존 비트맵에 삽입 위치 추가 (후속 인덱스 shift)
            if para_idx <= bits.len() {
                bits.insert(para_idx, true);
            }
            // 비트맵 길이를 문단 수에 맞춤
            bits.resize(para_count, false);
            // 분할 원본 문단도 dirty
            if para_idx > 0 {
                bits[para_idx - 1] = true;
            }
        }
        // para_offset 누적 (수렴 감지용)
        while self.para_offset.len() <= section_idx {
            self.para_offset.push(0);
        }
        self.para_offset[section_idx] += 1;
    }

    /// composed 벡터에서 문단 항목을 제거한다 (문단 병합/삭제 후).
    pub(crate) fn remove_composed_paragraph(&mut self, section_idx: usize, para_idx: usize) {
        self.invalidate_page_tree_cache();
        if para_idx < self.composed[section_idx].len() {
            self.composed[section_idx].remove(para_idx);
        }
        self.mark_section_dirty(section_idx);
        // measured_sections: 인덱스 조정으로 기존 측정값 재사용
        if section_idx < self.measured_sections.len() {
            self.measured_sections[section_idx].shift_for_remove(para_idx);
        }
        // dirty_paragraphs: 병합 대상 문단만 dirty 표시
        if section_idx < self.dirty_paragraphs.len() {
            let para_count = self.document.sections[section_idx].paragraphs.len();
            let bits =
                self.dirty_paragraphs[section_idx].get_or_insert_with(|| vec![false; para_count]);
            if para_idx < bits.len() {
                bits.remove(para_idx);
            }
            bits.resize(para_count, false);
            // 병합 결과 문단 dirty
            if para_idx < bits.len() {
                bits[para_idx] = true;
            }
            if para_idx > 0 && para_idx - 1 < bits.len() {
                bits[para_idx - 1] = true;
            }
        }
        // para_offset 누적 (수렴 감지용)
        while self.para_offset.len() <= section_idx {
            self.para_offset.push(0);
        }
        self.para_offset[section_idx] -= 1;
    }

    /// 모든 구역을 dirty로 표시한다.
    pub(crate) fn mark_all_sections_dirty(&mut self) {
        for d in &mut self.dirty_sections {
            *d = true;
        }
    }

    /// Batch 모드가 아닐 때만 paginate를 실행한다.
    /// Command 메서드에서 self.paginate() 대신 호출한다.
    pub(crate) fn paginate_if_needed(&mut self) {
        if !self.batch_mode {
            self.paginate();
        }
    }

    /// 모든 구역을 페이지로 분할한다 (dirty 구역만 재처리, 증분 표 측정).
    pub(crate) fn paginate(&mut self) {
        self.invalidate_page_tree_cache();
        let paginator = Paginator::new(self.dpi);
        let measurer = HeightMeasurer::new(self.dpi);

        if self.document.sections.is_empty() {
            self.pagination.clear();
            self.measured_tables.clear();
            self.measured_sections.clear();
            let default_section = Section::default();
            let empty_composed: Vec<ComposedParagraph> = Vec::new();
            let measured = measurer.measure_section(
                &default_section.paragraphs,
                &empty_composed,
                &self.styles,
            );
            let result = paginator.paginate_with_measured(
                &default_section.paragraphs,
                &measured,
                &default_section.section_def.page_def,
                &ColumnDef::default(),
                0,
                &self.styles.para_styles,
            );
            self.pagination.push(result);
            self.measured_tables.push(measured.tables.clone());
            self.measured_sections.push(measured);
            return;
        }

        // 벡터 크기 동기화
        let sec_count = self.document.sections.len();
        while self.pagination.len() < sec_count {
            self.pagination.push(PaginationResult {
                pages: Vec::new(),
                wrap_around_paras: Vec::new(),
                hidden_empty_paras: std::collections::HashSet::new(),
            });
        }
        self.pagination.truncate(sec_count);
        while self.para_column_map.len() < sec_count {
            self.para_column_map.push(Vec::new());
        }
        self.para_column_map.truncate(sec_count);
        while self.measured_tables.len() < sec_count {
            self.measured_tables.push(Vec::new());
        }
        self.measured_tables.truncate(sec_count);
        self.dirty_sections.resize(sec_count, true);
        self.dirty_sections.truncate(sec_count);
        while self.measured_sections.len() < sec_count {
            self.measured_sections.push(MeasuredSection {
                paragraphs: Vec::new(),
                tables: Vec::new(),
            });
        }
        self.measured_sections.truncate(sec_count);
        while self.dirty_paragraphs.len() < sec_count {
            self.dirty_paragraphs.push(None);
        }
        self.dirty_paragraphs.truncate(sec_count);

        // 구역 간 쪽번호 위치/번호 상속
        let mut carry_page_number_pos: Option<crate::model::control::PageNumberPos> = None;
        let mut carry_last_page_number: u32 = 0; // 이전 구역의 마지막 쪽번호

        // 구역 간 머리말/꼬리말 상속 (이전 구역의 홀수/짝수 페이지별 carry)
        use crate::renderer::pagination::HeaderFooterRef;
        let mut carry_header_odd: Option<HeaderFooterRef> = None;
        let mut carry_header_even: Option<HeaderFooterRef> = None;
        let mut carry_footer_odd: Option<HeaderFooterRef> = None;
        let mut carry_footer_even: Option<HeaderFooterRef> = None;

        for (idx, section) in self.document.sections.iter().enumerate() {
            if !self.dirty_sections[idx] {
                // dirty가 아닌 구역에서도 carry를 업데이트
                if let Some(pages) = self.pagination.get(idx) {
                    if let Some(last) = pages.pages.last() {
                        if last.page_number_pos.is_some() {
                            carry_page_number_pos = last.page_number_pos.clone();
                        }
                        carry_last_page_number = last.page_number;
                    }
                    // 머리말/꼬리말 carry 업데이트 (not-dirty 구역)
                    for page in &pages.pages {
                        let is_odd = page.page_number % 2 == 1;
                        if page.active_header.is_some() {
                            if is_odd {
                                carry_header_odd = page.active_header.clone();
                            } else {
                                carry_header_even = page.active_header.clone();
                            }
                        }
                        if page.active_footer.is_some() {
                            if is_odd {
                                carry_footer_odd = page.active_footer.clone();
                            } else {
                                carry_footer_even = page.active_footer.clone();
                            }
                        }
                    }
                }
                continue;
            }

            let composed = if idx < self.composed.len() {
                &self.composed[idx]
            } else {
                continue;
            };

            // 증분 측정: 이전 측정 데이터가 있으면 문단/표 수준 선택적 캐싱
            let measured = if !self.measured_sections[idx].paragraphs.is_empty() {
                let dirty_paras = self
                    .dirty_paragraphs
                    .get(idx)
                    .and_then(|opt| opt.as_deref());
                measurer.measure_section_selective(
                    &section.paragraphs,
                    composed,
                    &self.styles,
                    &self.measured_sections[idx],
                    dirty_paras,
                )
            } else {
                measurer.measure_section(&section.paragraphs, composed, &self.styles)
            };

            let column_def = Self::find_initial_column_def(&section.paragraphs);
            let mut result = paginator.paginate_with_measured_opts(
                &section.paragraphs,
                &measured,
                &section.section_def.page_def,
                &column_def,
                idx,
                &self.styles.para_styles,
                section.section_def.hide_empty_line,
            );

            // TypesetEngine 병렬 검증 (Phase 1: 비-표 구역)
            #[cfg(debug_assertions)]
            {
                use crate::renderer::typeset::TypesetEngine;
                let typesetter = TypesetEngine::new(self.dpi);
                let ts_result = typesetter.typeset_section(
                    &section.paragraphs,
                    composed,
                    &self.styles,
                    &section.section_def.page_def,
                    &column_def,
                    idx,
                    &measured.tables,
                );
                if result.pages.len() != ts_result.pages.len() {
                    eprintln!(
                        "TYPESET_VERIFY: sec{} 페이지 수 차이 (paginator={}, typeset={})",
                        idx,
                        result.pages.len(),
                        ts_result.pages.len(),
                    );
                    if std::env::var("TYPESET_DETAIL").is_ok() {
                        use crate::renderer::pagination::PageItem;
                        let describe_items =
                            |pages: &[crate::renderer::pagination::PageContent]| -> Vec<String> {
                                pages
                                    .iter()
                                    .map(|p| {
                                        let mut descs = Vec::new();
                                        for col in &p.column_contents {
                                            for item in &col.items {
                                                let d = match item {
                                                    PageItem::FullParagraph {
                                                        para_index, ..
                                                    } => format!("F{}", para_index),
                                                    PageItem::PartialParagraph {
                                                        para_index,
                                                        start_line,
                                                        end_line,
                                                        ..
                                                    } => format!(
                                                        "P{}({}-{})",
                                                        para_index, start_line, end_line
                                                    ),
                                                    PageItem::Table { para_index, .. } => {
                                                        format!("T{}", para_index)
                                                    }
                                                    PageItem::PartialTable {
                                                        para_index,
                                                        start_row,
                                                        end_row,
                                                        ..
                                                    } => format!(
                                                        "PT{}(r{}-{})",
                                                        para_index, start_row, end_row
                                                    ),
                                                    PageItem::Shape { para_index, .. } => {
                                                        format!("S{}", para_index)
                                                    }
                                                };
                                                descs.push(d);
                                            }
                                        }
                                        descs.join(",")
                                    })
                                    .collect()
                            };
                        let pag_descs = describe_items(&result.pages);
                        let ts_descs = describe_items(&ts_result.pages);
                        for i in 0..pag_descs.len().max(ts_descs.len()) {
                            let pr = pag_descs.get(i).map(|s| s.as_str()).unwrap_or("-");
                            let tr = ts_descs.get(i).map(|s| s.as_str()).unwrap_or("-");
                            if pr != tr || std::env::var("TYPESET_ALL_PAGES").is_ok() {
                                eprintln!("  page {:2}: pag=[{}]", i, pr);
                                eprintln!(
                                    "           ts =[{}]{}",
                                    tr,
                                    if pr != tr { " <<<" } else { "" }
                                );
                            }
                        }
                    }
                }
            }

            self.measured_tables[idx] = measured.tables.clone();
            self.measured_sections[idx] = measured;

            // ── 수렴 감지: 이전 페이지네이션과 비교하여 변경 흡수 지점 탐색 ──
            // 판단 후 검증: 수렴으로 복사한 결과를 full pagination과 비교하여 정합성 확인
            let offset = self.para_offset.get(idx).copied().unwrap_or(0);
            if offset != 0 {
                let old_result = &self.pagination[idx];
                if let Some(converge_page) = result.find_convergence(old_result, offset) {
                    let new_page_count = result.pages.len();
                    let old_page_count = old_result.pages.len();
                    if converge_page > 0
                        && converge_page < new_page_count
                        && converge_page < old_page_count
                    {
                        // 검증: full pagination에서 수렴 이후 페이지가 old+offset와 일치하는지 확인
                        let mut verified = true;
                        let check_end = result.pages.len().min(old_page_count);
                        for pi in converge_page..check_end {
                            let new_page = &result.pages[pi];
                            let old_page = &old_result.pages[pi];
                            let new_items: Vec<usize> = new_page
                                .column_contents
                                .iter()
                                .flat_map(|cc| cc.items.iter().map(|it| it.para_index()))
                                .collect();
                            let old_items: Vec<usize> = old_page
                                .column_contents
                                .iter()
                                .flat_map(|cc| {
                                    cc.items
                                        .iter()
                                        .map(|it| (it.para_index() as i64 + offset as i64) as usize)
                                })
                                .collect();
                            if new_items != old_items {
                                eprintln!("CONVERGENCE_VERIFY_FAIL: sec{} page {} new={:?} old+offset={:?}",
                                    idx, pi + 1, new_items, old_items);
                                verified = false;
                                break;
                            }
                        }
                        if result.pages.len() != old_page_count {
                            verified = false;
                        }

                        if verified {
                            eprintln!(
                                "CONVERGENCE: sec{} page {} 수렴 확인 ({}페이지 재사용 가능)",
                                idx,
                                converge_page + 1,
                                old_page_count - converge_page
                            );
                        }
                    }
                }
            }

            // 바탕쪽 선택 (기본 + 확장)
            if !section.section_def.master_pages.is_empty() {
                use crate::model::header_footer::HeaderFooterApply;
                use crate::renderer::pagination::MasterPageRef;

                let mps = &section.section_def.master_pages;
                // 기본 바탕쪽 (비확장 Both/Odd/Even)
                let mp_both = mps
                    .iter()
                    .position(|m| m.apply_to == HeaderFooterApply::Both && !m.is_extension);
                let mp_odd = mps
                    .iter()
                    .position(|m| m.apply_to == HeaderFooterApply::Odd && !m.is_extension);
                let mp_even = mps
                    .iter()
                    .position(|m| m.apply_to == HeaderFooterApply::Even && !m.is_extension);
                // 확장 바탕쪽 (is_extension=true, 마지막 쪽/임의 쪽)
                let ext_mp_indices: Vec<usize> = mps
                    .iter()
                    .enumerate()
                    .filter(|(_, m)| m.is_extension)
                    .map(|(i, _)| i)
                    .collect();

                // 구역 내 페이지 수 (마지막 쪽 판별용)
                let section_page_count = result.pages.len();

                for (page_idx_in_section, page) in result.pages.iter_mut().enumerate() {
                    let is_odd = page.page_number % 2 == 1;
                    let is_last = page_idx_in_section + 1 == section_page_count;
                    let is_first_page = page_idx_in_section == 0;

                    // 첫 쪽 감추기: hide_master_page가 true이면 첫 쪽에서 바탕쪽 미적용
                    if is_first_page && section.section_def.hide_master_page {
                        continue;
                    }

                    // 1. 기본 바탕쪽 선택: Odd/Even > Both
                    let selected = if is_odd {
                        mp_odd.or(mp_both)
                    } else {
                        mp_even.or(mp_both)
                    };
                    page.active_master_page = selected.map(|mi| MasterPageRef {
                        section_index: idx,
                        master_page_index: mi,
                    });

                    // 2. 확장 바탕쪽: 마지막 쪽에 적용
                    // 겹치기(overlap): 기존 바탕쪽 위에 추가
                    // 비겹치기: 기존 바탕쪽 대체
                    if is_last && !ext_mp_indices.is_empty() {
                        let overlap_exts: Vec<usize> = ext_mp_indices
                            .iter()
                            .filter(|&&i| mps[i].overlap)
                            .copied()
                            .collect();
                        let replace_exts: Vec<usize> = ext_mp_indices
                            .iter()
                            .filter(|&&i| !mps[i].overlap)
                            .copied()
                            .collect();

                        // 대체형 확장이 있으면 active를 대체
                        if let Some(&replace_idx) = replace_exts.last() {
                            page.active_master_page = Some(MasterPageRef {
                                section_index: idx,
                                master_page_index: replace_idx,
                            });
                        }
                        // 겹침형 확장은 extra로 추가
                        if !overlap_exts.is_empty() {
                            page.extra_master_pages = overlap_exts
                                .iter()
                                .map(|&mi| MasterPageRef {
                                    section_index: idx,
                                    master_page_index: mi,
                                })
                                .collect();
                        }
                    }
                }
            }

            // 머리말/꼬리말 carry 업데이트:
            // 페이지 active_header뿐 아니라 구역에 정의된 머리말 컨트롤도 carry에 반영
            // (짝수 페이지가 없어도 Even 머리말이 다음 구역에 상속되어야 함)
            {
                use crate::model::header_footer::HeaderFooterApply as HFA;
                for (pi, para) in section.paragraphs.iter().enumerate() {
                    for (ci, ctrl) in para.controls.iter().enumerate() {
                        match ctrl {
                            Control::Header(h) => {
                                let r = HeaderFooterRef {
                                    para_index: pi,
                                    control_index: ci,
                                    source_section_index: idx,
                                };
                                match h.apply_to {
                                    HFA::Both => {
                                        carry_header_odd = Some(r.clone());
                                        carry_header_even = Some(r);
                                    }
                                    HFA::Odd => {
                                        carry_header_odd = Some(r);
                                    }
                                    HFA::Even => {
                                        carry_header_even = Some(r);
                                    }
                                }
                            }
                            Control::Footer(f) => {
                                let r = HeaderFooterRef {
                                    para_index: pi,
                                    control_index: ci,
                                    source_section_index: idx,
                                };
                                match f.apply_to {
                                    HFA::Both => {
                                        carry_footer_odd = Some(r.clone());
                                        carry_footer_even = Some(r);
                                    }
                                    HFA::Odd => {
                                        carry_footer_odd = Some(r);
                                    }
                                    HFA::Even => {
                                        carry_footer_even = Some(r);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }

            // 구역 간 page_number_pos 상속: 이 구역에 PageNumberPos가 없으면 이전 구역 값 사용
            let section_has_own_pnp = result.pages.iter().any(|p| p.page_number_pos.is_some());
            if !section_has_own_pnp {
                if let Some(ref prev_pnp) = carry_page_number_pos {
                    for page in &mut result.pages {
                        page.page_number_pos = Some(prev_pnp.clone());
                    }
                }
            }

            // 구역 간 쪽번호 연속: NewNumber(Page) 컨트롤이 없으면 이전 구역에서 이어짐
            if idx > 0 && carry_last_page_number > 0 {
                use crate::model::control::{AutoNumberType, Control};
                let has_new_number = section.paragraphs.iter().any(|p|
                    p.controls.iter().any(|c| matches!(c, Control::NewNumber(nn) if nn.number_type == AutoNumberType::Page))
                );
                if !has_new_number {
                    for page in &mut result.pages {
                        page.page_number += carry_last_page_number;
                    }
                }
            }

            // 구역 간 머리말/꼬리말 상속 (쪽번호 보정 이후 실행)
            if idx > 0 {
                let section_has_header = result.pages.iter().any(|p| p.active_header.is_some());
                if !section_has_header {
                    for (pi, page) in result.pages.iter_mut().enumerate() {
                        let is_odd = page.page_number % 2 == 1;
                        page.active_header = if is_odd {
                            carry_header_odd
                                .clone()
                                .or_else(|| carry_header_even.clone())
                        } else {
                            carry_header_even
                                .clone()
                                .or_else(|| carry_header_odd.clone())
                        };
                    }
                }
                let section_has_footer = result.pages.iter().any(|p| p.active_footer.is_some());
                if !section_has_footer {
                    for (pi, page) in result.pages.iter_mut().enumerate() {
                        let is_odd = page.page_number % 2 == 1;
                        page.active_footer = if is_odd {
                            carry_footer_odd
                                .clone()
                                .or_else(|| carry_footer_even.clone())
                        } else {
                            carry_footer_even
                                .clone()
                                .or_else(|| carry_footer_odd.clone())
                        };
                    }
                }
            }
            // 첫 쪽 감추기: hide_header/hide_footer가 true이면 구역 첫 쪽의 머리말/꼬리말 제거
            if section.section_def.hide_header {
                if let Some(first_page) = result.pages.first_mut() {
                    first_page.active_header = None;
                }
            }
            if section.section_def.hide_footer {
                if let Some(first_page) = result.pages.first_mut() {
                    first_page.active_footer = None;
                }
            }

            // carry 업데이트
            if let Some(last) = result.pages.last() {
                if last.page_number_pos.is_some() {
                    carry_page_number_pos = last.page_number_pos.clone();
                }
                carry_last_page_number = last.page_number;
            }

            // 같은 구역 내 머리말/꼬리말 보정:
            // pagination에서 머리말이 누락된 페이지에 구역의 머리말 컨트롤을 직접 할당
            {
                use crate::model::header_footer::HeaderFooterApply as HFA;
                let mut sec_h_odd: Option<HeaderFooterRef> = None;
                let mut sec_h_even: Option<HeaderFooterRef> = None;
                let mut sec_h_both: Option<HeaderFooterRef> = None;
                let mut sec_f_odd: Option<HeaderFooterRef> = None;
                let mut sec_f_even: Option<HeaderFooterRef> = None;
                let mut sec_f_both: Option<HeaderFooterRef> = None;
                for (pi, para) in section.paragraphs.iter().enumerate() {
                    for (ci, ctrl) in para.controls.iter().enumerate() {
                        match ctrl {
                            Control::Header(h) => {
                                let r = HeaderFooterRef {
                                    para_index: pi,
                                    control_index: ci,
                                    source_section_index: idx,
                                };
                                match h.apply_to {
                                    HFA::Both => sec_h_both = Some(r),
                                    HFA::Even => sec_h_even = Some(r),
                                    HFA::Odd => sec_h_odd = Some(r),
                                }
                            }
                            Control::Footer(f) => {
                                let r = HeaderFooterRef {
                                    para_index: pi,
                                    control_index: ci,
                                    source_section_index: idx,
                                };
                                match f.apply_to {
                                    HFA::Both => sec_f_both = Some(r),
                                    HFA::Even => sec_f_even = Some(r),
                                    HFA::Odd => sec_f_odd = Some(r),
                                }
                            }
                            _ => {}
                        }
                    }
                }
                let has_hf = sec_h_odd.is_some()
                    || sec_h_even.is_some()
                    || sec_h_both.is_some()
                    || sec_f_odd.is_some()
                    || sec_f_even.is_some()
                    || sec_f_both.is_some();
                // 머리말/꼬리말이 정의된 문단이 시작되는 페이지를 찾아
                // 그 페이지부터만 적용 (정의 이전 페이지에는 미적용)
                use crate::renderer::pagination::PageItem;
                let hdr_start_page = [&sec_h_odd, &sec_h_even, &sec_h_both]
                    .iter()
                    .filter_map(|r| r.as_ref())
                    .map(|r| r.para_index)
                    .min()
                    .and_then(|hdr_pi| {
                        result.pages.iter().position(|p| {
                            p.column_contents.iter().any(|cc| {
                                cc.items.iter().any(|item| {
                                    let pi = match item {
                                        PageItem::FullParagraph { para_index } => *para_index,
                                        PageItem::PartialParagraph { para_index, .. } => {
                                            *para_index
                                        }
                                        PageItem::Table { para_index, .. } => *para_index,
                                        PageItem::PartialTable { para_index, .. } => *para_index,
                                        PageItem::Shape { para_index, .. } => *para_index,
                                    };
                                    pi >= hdr_pi
                                })
                            })
                        })
                    })
                    .unwrap_or(0);
                let ftr_start_page = [&sec_f_odd, &sec_f_even, &sec_f_both]
                    .iter()
                    .filter_map(|r| r.as_ref())
                    .map(|r| r.para_index)
                    .min()
                    .and_then(|ftr_pi| {
                        result.pages.iter().position(|p| {
                            p.column_contents.iter().any(|cc| {
                                cc.items.iter().any(|item| {
                                    let pi = match item {
                                        PageItem::FullParagraph { para_index } => *para_index,
                                        PageItem::PartialParagraph { para_index, .. } => {
                                            *para_index
                                        }
                                        PageItem::Table { para_index, .. } => *para_index,
                                        PageItem::PartialTable { para_index, .. } => *para_index,
                                        PageItem::Shape { para_index, .. } => *para_index,
                                    };
                                    pi >= ftr_pi
                                })
                            })
                        })
                    })
                    .unwrap_or(0);
                if has_hf {
                    for (page_idx, page) in result.pages.iter_mut().enumerate() {
                        let is_odd = page.page_number % 2 == 1;
                        if page.active_header.is_none() && page_idx >= hdr_start_page {
                            page.active_header = if is_odd {
                                sec_h_odd.clone().or_else(|| sec_h_both.clone())
                            } else {
                                sec_h_even.clone().or_else(|| sec_h_both.clone())
                            };
                        } else {
                            // pagination에서 할당된 머리말의 apply_to가 현재 페이지 홀짝과 맞지 않으면 교체
                            if let Some(ref hdr_ref) = page.active_header {
                                if let Some(para) = section.paragraphs.get(hdr_ref.para_index) {
                                    if let Some(Control::Header(h)) =
                                        para.controls.get(hdr_ref.control_index)
                                    {
                                        let correct = match h.apply_to {
                                            HFA::Both => true,
                                            HFA::Odd => is_odd,
                                            HFA::Even => !is_odd,
                                        };
                                        if !correct {
                                            page.active_header = if is_odd {
                                                sec_h_odd.clone().or_else(|| sec_h_both.clone())
                                            } else {
                                                sec_h_even.clone().or_else(|| sec_h_both.clone())
                                            };
                                        }
                                    }
                                }
                            }
                        }
                        if page.active_footer.is_none() && page_idx >= ftr_start_page {
                            page.active_footer = if is_odd {
                                sec_f_odd.clone().or_else(|| sec_f_both.clone())
                            } else {
                                sec_f_even.clone().or_else(|| sec_f_both.clone())
                            };
                        } else {
                            if let Some(ref ftr_ref) = page.active_footer {
                                if let Some(para) = section.paragraphs.get(ftr_ref.para_index) {
                                    if let Some(Control::Footer(f)) =
                                        para.controls.get(ftr_ref.control_index)
                                    {
                                        let correct = match f.apply_to {
                                            HFA::Both => true,
                                            HFA::Odd => is_odd,
                                            HFA::Even => !is_odd,
                                        };
                                        if !correct {
                                            page.active_footer = if is_odd {
                                                sec_f_odd.clone().or_else(|| sec_f_both.clone())
                                            } else {
                                                sec_f_even.clone().or_else(|| sec_f_both.clone())
                                            };
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            self.pagination[idx] = result;
            self.dirty_sections[idx] = false;
            // 문단 dirty 비트맵 초기화 (모든 문단 clean)
            let para_count = section.paragraphs.len();
            self.dirty_paragraphs[idx] = Some(vec![false; para_count]);

            // 문단→단 인덱스 매핑 구축
            {
                use crate::renderer::pagination::PageItem;
                let mut col_map = vec![0u16; para_count];
                for page in &self.pagination[idx].pages {
                    for col_content in &page.column_contents {
                        let ci = col_content.column_index;
                        for item in &col_content.items {
                            let pi = match item {
                                PageItem::FullParagraph { para_index } => *para_index,
                                PageItem::PartialParagraph { para_index, .. } => *para_index,
                                PageItem::Table { para_index, .. } => *para_index,
                                PageItem::PartialTable { para_index, .. } => *para_index,
                                PageItem::Shape { para_index, .. } => *para_index,
                            };
                            if pi < col_map.len() {
                                col_map[pi] = ci;
                            }
                        }
                    }
                }
                self.para_column_map[idx] = col_map;
            }
        }

        // para_offset 리셋 (수렴 감지 완료)
        for off in &mut self.para_offset {
            *off = 0;
        }

        // 표 dirty 플래그 초기화
        for section in &mut self.document.sections {
            for para in &mut section.paragraphs {
                for ctrl in &mut para.controls {
                    if let Control::Table(table) = ctrl {
                        table.dirty = false;
                    }
                }
            }
        }
    }

    /// 글로벌 페이지 번호로 해당 페이지와 문단/구성 목록을 찾는다.
    pub(crate) fn find_page(
        &self,
        page_num: u32,
    ) -> Result<
        (
            &crate::renderer::pagination::PageContent,
            &[crate::model::paragraph::Paragraph],
            &[ComposedParagraph],
        ),
        HwpError,
    > {
        let mut offset = 0u32;
        for (sec_idx, pr) in self.pagination.iter().enumerate() {
            if (page_num as usize) < offset as usize + pr.pages.len() {
                let local_idx = (page_num - offset) as usize;
                let paragraphs = if sec_idx < self.document.sections.len() {
                    &self.document.sections[sec_idx].paragraphs[..]
                } else {
                    &[][..]
                };
                let composed = if sec_idx < self.composed.len() {
                    &self.composed[sec_idx][..]
                } else {
                    &[][..]
                };
                return Ok((&pr.pages[local_idx], paragraphs, composed));
            }
            offset += pr.pages.len() as u32;
        }
        Err(HwpError::PageOutOfRange(page_num))
    }

    /// 페이지네이션 결과를 텍스트로 덤프 (디버깅용).
    /// page_filter: None이면 전체, Some(n)이면 해당 페이지만.
    pub fn dump_page_items(&self, page_filter: Option<u32>) -> String {
        use crate::model::control::Control;
        use crate::renderer::hwpunit_to_px;
        use crate::renderer::pagination::PageItem;

        let dpi = self.dpi;
        let mut out = String::new();
        let mut global_page = 0u32;

        for (sec_idx, pr) in self.pagination.iter().enumerate() {
            let paragraphs = self
                .document
                .sections
                .get(sec_idx)
                .map(|s| &s.paragraphs[..])
                .unwrap_or(&[]);
            let measured = self.measured_sections.get(sec_idx);

            for (local_idx, page) in pr.pages.iter().enumerate() {
                if let Some(pf) = page_filter {
                    if global_page != pf {
                        global_page += 1;
                        continue;
                    }
                }

                out.push_str(&format!(
                    "\n=== 페이지 {} (global_idx={}, section={}, page_num={}) ===\n",
                    global_page + 1,
                    global_page,
                    sec_idx,
                    page.page_number
                ));

                // 페이지 레이아웃 정보
                let la = &page.layout;
                out.push_str(&format!(
                    "  body_area: x={:.1} y={:.1} w={:.1} h={:.1}\n",
                    la.body_area.x, la.body_area.y, la.body_area.width, la.body_area.height
                ));

                for (col_idx, cc) in page.column_contents.iter().enumerate() {
                    out.push_str(&format!(
                        "  단 {} (items={}{})\n",
                        col_idx,
                        cc.items.len(),
                        if cc.zone_y_offset > 0.0 {
                            format!(", zone_y_offset={:.1}", cc.zone_y_offset)
                        } else {
                            String::new()
                        }
                    ));

                    for item in &cc.items {
                        match item {
                            PageItem::FullParagraph { para_index } => {
                                let text_preview = paragraphs
                                    .get(*para_index)
                                    .map(|p| {
                                        let t: String = p
                                            .text
                                            .chars()
                                            .filter(|c| *c > '\u{001F}')
                                            .take(40)
                                            .collect();
                                        if t.is_empty() {
                                            "(빈)".to_string()
                                        } else {
                                            t
                                        }
                                    })
                                    .unwrap_or_default();
                                let height = measured
                                    .and_then(|m| m.get_measured_paragraph(*para_index))
                                    .map(|mp| {
                                        let sb = mp.spacing_before;
                                        let sa = mp.spacing_after;
                                        let lines: f64 = mp.line_heights.iter().sum();
                                        format!(
                                            "h={:.1} (sb={:.1} lines={:.1} sa={:.1})",
                                            sb + lines + sa,
                                            sb,
                                            lines,
                                            sa
                                        )
                                    })
                                    .unwrap_or_default();
                                out.push_str(&format!(
                                    "    FullParagraph  pi={}  {}  \"{}\"\n",
                                    para_index, height, text_preview
                                ));
                            }
                            PageItem::PartialParagraph {
                                para_index,
                                start_line,
                                end_line,
                            } => {
                                out.push_str(&format!(
                                    "    PartialParagraph  pi={}  lines={}..{}\n",
                                    para_index, start_line, end_line
                                ));
                            }
                            PageItem::Table {
                                para_index,
                                control_index,
                            } => {
                                let table_info = paragraphs
                                    .get(*para_index)
                                    .and_then(|p| p.controls.get(*control_index))
                                    .map(|c| {
                                        if let Control::Table(t) = c {
                                            let h = hwpunit_to_px(t.common.height as i32, dpi);
                                            let w = hwpunit_to_px(t.common.width as i32, dpi);
                                            format!(
                                                "{}x{}  {:.1}x{:.1}px  wrap={:?} tac={}",
                                                t.row_count,
                                                t.col_count,
                                                w,
                                                h,
                                                t.common.text_wrap,
                                                t.common.treat_as_char
                                            )
                                        } else {
                                            String::new()
                                        }
                                    })
                                    .unwrap_or_default();
                                out.push_str(&format!(
                                    "    Table          pi={} ci={}  {}\n",
                                    para_index, control_index, table_info
                                ));
                            }
                            PageItem::PartialTable {
                                para_index,
                                control_index,
                                start_row,
                                end_row,
                                is_continuation,
                                ..
                            } => {
                                let table_info = paragraphs
                                    .get(*para_index)
                                    .and_then(|p| p.controls.get(*control_index))
                                    .map(|c| {
                                        if let Control::Table(t) = c {
                                            format!("{}x{}", t.row_count, t.col_count)
                                        } else {
                                            String::new()
                                        }
                                    })
                                    .unwrap_or_default();
                                out.push_str(&format!(
                                    "    PartialTable   pi={} ci={}  rows={}..{}  cont={}  {}\n",
                                    para_index,
                                    control_index,
                                    start_row,
                                    end_row,
                                    is_continuation,
                                    table_info
                                ));
                            }
                            PageItem::Shape {
                                para_index,
                                control_index,
                            } => {
                                let shape_info = paragraphs
                                    .get(*para_index)
                                    .and_then(|p| p.controls.get(*control_index))
                                    .map(|c| match c {
                                        Control::Shape(s) => format!(
                                            "wrap={:?} tac={}",
                                            s.common().text_wrap,
                                            s.common().treat_as_char
                                        ),
                                        Control::Picture(p) => {
                                            format!("그림 tac={}", p.common.treat_as_char)
                                        }
                                        Control::Equation(_) => "수식".to_string(),
                                        _ => String::new(),
                                    })
                                    .unwrap_or_default();
                                out.push_str(&format!(
                                    "    Shape          pi={} ci={}  {}\n",
                                    para_index, control_index, shape_info
                                ));
                            }
                        }
                    }
                }

                global_page += 1;
            }
        }

        out
    }

    /// 페이지 렌더 트리 캐시 무효화 (from_page 이상 페이지만 무효화).
    pub(crate) fn invalidate_page_tree_cache_from(&self, from_page: u32) {
        let mut cache = self.page_tree_cache.borrow_mut();
        let from = from_page as usize;
        for i in from..cache.len() {
            cache[i] = None;
        }
        self.page_layer_tree_cache
            .borrow_mut()
            .retain(|cache_key, _| cache_key.page_num < from_page);
    }

    /// 페이지 렌더 트리 캐시 전체 무효화.
    pub(crate) fn invalidate_page_tree_cache(&self) {
        self.page_tree_cache.borrow_mut().clear();
        self.page_layer_tree_cache.borrow_mut().clear();
    }

    /// 캐시된 페이지 렌더 트리를 반환한다 (캐시 미스 시 빌드 후 캐시).
    pub(crate) fn build_page_tree_cached(&self, page_num: u32) -> Result<PageRenderTree, HwpError> {
        let idx = page_num as usize;

        // 캐시 크기 확보 + 히트 확인
        {
            let mut cache = self.page_tree_cache.borrow_mut();
            if cache.len() <= idx {
                cache.resize_with(idx + 1, || None);
            }
            if let Some(ref tree) = cache[idx] {
                return Ok(tree.clone());
            }
        }

        // 캐시 미스 → 빌드
        let tree = self.build_page_tree(page_num)?;
        let cloned = tree.clone();

        {
            let mut cache = self.page_tree_cache.borrow_mut();
            if cache.len() <= idx {
                cache.resize_with(idx + 1, || None);
            }
            cache[idx] = Some(cloned);
        }

        Ok(tree)
    }

    /// 캐시된 페이지 렌더 트리를 복제하지 않고 참조로 사용한다.
    pub(crate) fn with_page_tree_cached<T>(
        &self,
        page_num: u32,
        build: impl FnOnce(&PageRenderTree) -> Result<T, HwpError>,
    ) -> Result<T, HwpError> {
        let idx = page_num as usize;
        let cached = self
            .page_tree_cache
            .borrow()
            .get(idx)
            .is_some_and(Option::is_some);

        if !cached {
            let tree = self.build_page_tree(page_num)?;
            let mut cache = self.page_tree_cache.borrow_mut();
            if cache.len() <= idx {
                cache.resize_with(idx + 1, || None);
            }
            cache[idx] = Some(tree);
        }

        let cache = self.page_tree_cache.borrow();
        let tree = cache[idx]
            .as_ref()
            .expect("페이지 tree cache는 채운 뒤에 참조해야 한다");
        build(tree)
    }

    /// 캐시된 페이지 레이어 트리를 반환한다 (캐시 미스 시 빌드 후 캐시).
    pub(crate) fn build_page_layer_tree_cached(
        &self,
        page_num: u32,
        profile: RenderProfile,
    ) -> Result<PageLayerTree, HwpError> {
        let cache_key = self.page_layer_tree_cache_key(page_num, profile);
        if let Some(tree) = self.page_layer_tree_cache.borrow().get(&cache_key) {
            let _overflows = self.layout_engine.take_overflows();
            return Ok(tree.clone());
        }

        let page_tree = self.build_page_tree_cached(page_num)?;
        let _overflows = self.layout_engine.take_overflows();
        let layer_tree = self.build_layer_tree_from_page_tree(&page_tree, profile);
        self.page_layer_tree_cache
            .borrow_mut()
            .insert(cache_key, layer_tree.clone());
        Ok(layer_tree)
    }

    fn page_layer_tree_cache_key(
        &self,
        page_num: u32,
        profile: RenderProfile,
    ) -> super::super::PageLayerTreeCacheKey {
        super::super::PageLayerTreeCacheKey {
            page_num,
            profile,
            show_paragraph_marks: self.show_paragraph_marks,
            show_control_codes: self.show_control_codes,
            show_transparent_borders: self.show_transparent_borders,
            clip_enabled: self.clip_enabled,
            debug_overlay: self.debug_overlay,
        }
    }

    /// 페이지 렌더 트리를 빌드한다.
    pub(crate) fn build_page_tree(&self, page_num: u32) -> Result<PageRenderTree, HwpError> {
        use crate::model::style::HeadType;
        use crate::renderer::layout::resolve_numbering_id;
        use crate::renderer::pagination::PageItem;

        self.layout_engine
            .set_show_transparent_borders(self.show_transparent_borders);
        self.layout_engine.set_clip_enabled(self.clip_enabled);
        self.layout_engine.set_hwpx_source(matches!(
            self.source_format,
            crate::parser::FileFormat::Hwpx
        ));
        self.layout_engine
            .set_show_control_codes(self.show_control_codes);
        // 활성 필드 정보를 레이아웃 엔진에 전달 (안내문 숨김용)
        self.layout_engine
            .set_active_field(self.active_field.as_ref().map(|af| {
                (
                    af.section_idx,
                    af.para_idx,
                    af.control_idx,
                    af.cell_path.clone(),
                )
            }));
        let (page_content, paragraphs, composed) = self.find_page(page_num)?;
        // 구역의 각주 모양 정보
        let footnote_shape = if page_content.section_index < self.document.sections.len() {
            &self.document.sections[page_content.section_index]
                .section_def
                .footnote_shape
        } else {
            &crate::model::footnote::FootnoteShape::default()
        };
        // 활성 바탕쪽 조회
        let active_mp = page_content.active_master_page.as_ref().and_then(|mp_ref| {
            self.document
                .sections
                .get(mp_ref.section_index)
                .and_then(|s| s.section_def.master_pages.get(mp_ref.master_page_index))
        });
        // 확장 바탕쪽 조회
        let extra_mps: Vec<&crate::model::header_footer::MasterPage> = page_content
            .extra_master_pages
            .iter()
            .filter_map(|mp_ref| {
                self.document
                    .sections
                    .get(mp_ref.section_index)
                    .and_then(|s| s.section_def.master_pages.get(mp_ref.master_page_index))
            })
            .collect();
        let sec_measured = self
            .measured_tables
            .get(page_content.section_index)
            .map(|v| v.as_slice())
            .unwrap_or(&[]);
        // 쪽 테두리/배경 조회
        let page_border_fill = self
            .document
            .sections
            .get(page_content.section_index)
            .map(|s| &s.section_def.page_border_fill);
        let outline_num_id = self
            .document
            .sections
            .get(page_content.section_index)
            .map(|s| s.section_def.outline_numbering_id)
            .unwrap_or(0);

        // 번호 상태 리셋 후, 이 페이지 이전의 번호 문단을 재계산하여 카운터 복원
        // (이전 구역 + 현재 구역의 이전 페이지 모두 포함하여 구역 간 번호 연속 지원)
        self.layout_engine.reset_numbering_state();
        let sec_idx = page_content.section_index;
        let sec_page_offset: usize = self
            .pagination
            .iter()
            .take(sec_idx)
            .map(|p| p.pages.len())
            .sum();
        let local_idx = (page_num as usize).saturating_sub(sec_page_offset);
        {
            let mut replayed_partial: std::collections::HashSet<(usize, usize)> =
                std::collections::HashSet::new();
            // 이전 구역들의 모든 페이지 replay
            for prev_sec in 0..sec_idx {
                if let Some(pr) = self.pagination.get(prev_sec) {
                    let prev_paras = &self.document.sections[prev_sec].paragraphs;
                    let prev_outline_id = self.document.sections[prev_sec]
                        .section_def
                        .outline_numbering_id;
                    for pg in &pr.pages {
                        self.replay_numbering_page(
                            pg,
                            prev_paras,
                            prev_outline_id,
                            &mut replayed_partial,
                            prev_sec,
                        );
                    }
                }
            }
            // 현재 구역의 이전 페이지들 replay
            if let Some(pr) = self.pagination.get(sec_idx) {
                for prev_local in 0..local_idx {
                    if let Some(prev_page) = pr.pages.get(prev_local) {
                        self.replay_numbering_page(
                            prev_page,
                            paragraphs,
                            outline_num_id,
                            &mut replayed_partial,
                            sec_idx,
                        );
                    }
                }
            }
        }

        // 머리말/꼬리말이 상속된 경우 원본 구역의 문단을 조회 (source_section_index 기반)
        let header_paragraphs: &[crate::model::paragraph::Paragraph] = page_content
            .active_header
            .as_ref()
            .and_then(|hf| self.document.sections.get(hf.source_section_index))
            .map(|s| s.paragraphs.as_slice())
            .unwrap_or(paragraphs);
        let footer_paragraphs: &[crate::model::paragraph::Paragraph] = page_content
            .active_footer
            .as_ref()
            .and_then(|hf| self.document.sections.get(hf.source_section_index))
            .map(|s| s.paragraphs.as_slice())
            .unwrap_or(paragraphs);

        // 머리말/꼬리말 감추기 세트를 레이아웃 엔진에 전달
        self.layout_engine
            .set_hidden_header_footer(&self.hidden_header_footer);

        // 총 쪽수·파일 이름을 레이아웃 엔진에 전달 (머리말/꼬리말 필드 치환용)
        let total_pages: u32 = self.pagination.iter().map(|p| p.pages.len() as u32).sum();
        self.layout_engine.set_total_pages(total_pages);
        self.layout_engine.set_file_name(&self.file_name);

        let wrap_around_paras = self
            .pagination
            .get(sec_idx)
            .map(|pr| pr.wrap_around_paras.as_slice())
            .unwrap_or(&[]);

        // 빈 줄 감추기 문단 집합을 레이아웃 엔진에 전달
        if let Some(pr) = self.pagination.get(sec_idx) {
            self.layout_engine
                .set_hidden_empty_paras(&pr.hidden_empty_paras);
        }

        let mut tree = self.layout_engine.build_render_tree(
            page_content,
            paragraphs,
            header_paragraphs,
            footer_paragraphs,
            composed,
            &self.styles,
            footnote_shape,
            &self.document.bin_data_content,
            active_mp,
            sec_measured,
            page_border_fill,
            outline_num_id,
            wrap_around_paras,
        );
        // 확장 바탕쪽 추가 렌더링
        for ext_mp in &extra_mps {
            self.layout_engine.build_master_page_into(
                &mut tree,
                Some(*ext_mp),
                &page_content.layout,
                composed,
                &self.styles,
                &self.document.bin_data_content,
                page_content.section_index,
                page_content.page_number,
            );
        }
        // Apply once after every page/master-page node is present so all
        // direct backends receive the same seam-free image geometry.
        tree.clip_overlapping_same_bin_images();
        Ok(tree)
    }

    /// 한 페이지의 번호 문단을 replay하여 카운터를 전진시킨다.
    fn replay_numbering_page(
        &self,
        page: &crate::renderer::pagination::PageContent,
        paras: &[crate::model::paragraph::Paragraph],
        outline_num_id: u16,
        replayed: &mut std::collections::HashSet<(usize, usize)>,
        sec_idx: usize,
    ) {
        use crate::model::style::HeadType;
        use crate::renderer::pagination::PageItem;
        for col in &page.column_contents {
            for item in &col.items {
                let pi = match item {
                    PageItem::FullParagraph { para_index }
                    | PageItem::PartialParagraph { para_index, .. }
                    | PageItem::Table { para_index, .. } => {
                        if replayed.insert((sec_idx, *para_index)) {
                            Some(*para_index)
                        } else {
                            None
                        }
                    }
                    _ => None,
                };
                if let Some(pi) = pi {
                    if let Some(para) = paras.get(pi) {
                        if let Some(ps) = self.styles.para_styles.get(para.para_shape_id as usize) {
                            if ps.head_type == HeadType::Outline || ps.head_type == HeadType::Number
                            {
                                let nid = crate::renderer::layout::resolve_numbering_id(
                                    ps.head_type,
                                    ps.numbering_id,
                                    outline_num_id,
                                );
                                if nid > 0 {
                                    self.layout_engine.advance_numbering(nid, ps.para_level);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    pub(crate) fn rebuild_section(&mut self, section_idx: usize) {
        self.styles = resolve_styles(&self.document.doc_info, self.dpi);
        self.recompose_section(section_idx);
        self.paginate();
    }

    // =====================================================================
    // 클립보드 API (내부)
    // =====================================================================
}

#[cfg(test)]
mod embedded_font_tests {
    use super::*;
    use crate::model::bin_data::{BinDataBytes, BinDataContent, BinDataResolver};
    use crate::model::style::{CharShape, Font};
    use crate::paint::PaintOp;
    use crate::renderer::render_tree::{
        BoundingBox, FieldMarkerType, RenderNode, RenderNodeType, TextRunNode,
    };
    use crate::renderer::TextStyle;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[derive(Debug)]
    struct LimitedFontResolver {
        bytes: Vec<u8>,
        limited_calls: Arc<AtomicUsize>,
    }

    impl BinDataResolver for LimitedFontResolver {
        fn resolve(&self, _key: &str) -> Vec<u8> {
            panic!("embedded font rendering must not use unbounded resolve")
        }

        fn resolve_limited(&self, _key: &str, max_bytes: usize) -> Option<Vec<u8>> {
            self.limited_calls.fetch_add(1, Ordering::SeqCst);
            (self.bytes.len() <= max_bytes).then(|| self.bytes.clone())
        }
    }

    #[derive(Debug)]
    struct UnusedFontResolver;

    impl BinDataResolver for UnusedFontResolver {
        fn resolve(&self, _key: &str) -> Vec<u8> {
            panic!("unused embedded font must stay lazy")
        }

        fn resolve_limited(&self, _key: &str, _max_bytes: usize) -> Option<Vec<u8>> {
            panic!("unused embedded font must stay lazy")
        }
    }

    #[test]
    fn page_layer_build_loads_only_used_embedded_font_through_bounded_resolver() {
        let font_bytes =
            include_bytes!("../../../tests/fixtures/fonts/RHWPBitmapSvgGlyphSmoke.ttf");
        let limited_calls = Arc::new(AtomicUsize::new(0));
        let mut core = DocumentCore::new_empty();
        core.document.doc_info.font_faces = vec![Vec::new(); 7];
        core.document.doc_info.font_faces[0] = (0..MAX_PAGE_EMBEDDED_FONT_FACES)
            .map(|index| Font {
                name: format!("Non-embedded face {index}"),
                ..Font::default()
            })
            .chain([
                Font {
                    name: "RHWP Bitmap SVG Glyph Smoke".to_string(),
                    is_embedded: true,
                    resolved_bin_data_id: Some(1),
                    ..Font::default()
                },
                Font {
                    name: "Unused Embedded Face".to_string(),
                    is_embedded: true,
                    resolved_bin_data_id: Some(2),
                    ..Font::default()
                },
            ])
            .collect();
        core.document.doc_info.char_shapes = (0..MAX_PAGE_EMBEDDED_FONT_FACES + 2)
            .map(|font_id| CharShape {
                font_ids: [u16::try_from(font_id).unwrap(); 7],
                ..CharShape::default()
            })
            .collect();
        core.document.bin_data_content = vec![
            BinDataContent {
                id: 1,
                data: BinDataBytes::Lazy {
                    resolver: Arc::new(LimitedFontResolver {
                        bytes: font_bytes.to_vec(),
                        limited_calls: Arc::clone(&limited_calls),
                    }),
                    key: "used-font".to_string(),
                },
                extension: "ttf".to_string(),
            },
            BinDataContent {
                id: 2,
                data: BinDataBytes::Lazy {
                    resolver: Arc::new(UnusedFontResolver),
                    key: "unused-font".to_string(),
                },
                extension: "ttf".to_string(),
            },
        ];

        let mut tree = PageRenderTree::new(0, 100.0, 100.0);
        for char_shape_id in 0..MAX_PAGE_EMBEDDED_FONT_FACES {
            tree.root.children.push(RenderNode::new(
                u32::try_from(char_shape_id + 1).unwrap(),
                RenderNodeType::TextRun(TextRunNode {
                    text: "A".to_string(),
                    style: TextStyle {
                        font_family: format!("Non-embedded face {char_shape_id}"),
                        font_language_index: Some(0),
                        font_size: 16.0,
                        ..TextStyle::default()
                    },
                    char_shape_id: Some(u32::try_from(char_shape_id).unwrap()),
                    para_shape_id: None,
                    section_index: None,
                    para_index: None,
                    char_start: None,
                    cell_context: None,
                    is_para_end: false,
                    is_line_break_end: false,
                    rotation: 0.0,
                    is_vertical: false,
                    char_overlap: None,
                    border_fill_id: 0,
                    baseline: 12.0,
                    field_marker: FieldMarkerType::None,
                }),
                BoundingBox::new(10.0, 20.0, 16.0, 16.0),
            ));
        }
        tree.root.children.push(RenderNode::new(
            u32::try_from(MAX_PAGE_EMBEDDED_FONT_FACES + 1).unwrap(),
            RenderNodeType::TextRun(TextRunNode {
                text: "\u{E100}".to_string(),
                style: TextStyle {
                    font_family: "unrelated CSS fallback".to_string(),
                    font_language_index: Some(0),
                    font_size: 16.0,
                    ..TextStyle::default()
                },
                char_shape_id: Some(u32::try_from(MAX_PAGE_EMBEDDED_FONT_FACES).unwrap()),
                para_shape_id: None,
                section_index: None,
                para_index: None,
                char_start: None,
                cell_context: None,
                is_para_end: false,
                is_line_break_end: false,
                rotation: 0.0,
                is_vertical: false,
                char_overlap: None,
                border_fill_id: 0,
                baseline: 12.0,
                field_marker: FieldMarkerType::None,
            }),
            BoundingBox::new(10.0, 20.0, 16.0, 16.0),
        ));

        let layer_tree = core.build_layer_tree_from_page_tree(&tree, RenderProfile::Screen);

        assert_eq!(limited_calls.load(Ordering::SeqCst), 1);
        assert_eq!(layer_tree.resources.image_count(), 1);
        assert!(matches!(
            layer_tree.variant_ops.as_slice(),
            [PaintOp::GlyphOutline { .. }]
        ));
        crate::paint::validate_text_variant_scope(&layer_tree)
            .expect("font-native sidecar must anchor to the used TextRun");
        let validation =
            layer_tree.validate_text_v2_slots(&crate::paint::TextV2ValidationOptions {
                allow_richer_glyph_outline_payloads: true,
                allow_bitmap_glyph_payloads: true,
                ..crate::paint::TextV2ValidationOptions::default()
            });
        assert!(
            validation.is_empty(),
            "font-native sidecar must satisfy the v2 bitmap payload contract: {validation:?}"
        );
    }
}
