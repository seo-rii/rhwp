//! 패스 레코드 — BeginPath/EndPath/CloseFigure/FillPath/StrokePath.

use crate::emf::Error;
use crate::emf::parser::{Cursor, objects::RectL};

pub fn parse_path_bounds(c: &mut Cursor<'_>) -> Result<RectL, Error> {
    RectL::read(c)
}
