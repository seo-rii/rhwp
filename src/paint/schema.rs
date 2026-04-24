/// Versioned root metadata for PageLayerTree JSON and JS-value exports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayerTreeSchema {
    pub schema_version: u32,
    pub resource_table_version: u32,
    pub unit: &'static str,
    pub coordinate_system: &'static str,
}

pub const LAYER_TREE_SCHEMA: LayerTreeSchema = LayerTreeSchema {
    schema_version: 1,
    resource_table_version: 1,
    unit: "px",
    coordinate_system: "page-top-left-y-down",
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_tree_schema_contract_is_stable() {
        assert_eq!(LAYER_TREE_SCHEMA.schema_version, 1);
        assert_eq!(LAYER_TREE_SCHEMA.resource_table_version, 1);
        assert_eq!(LAYER_TREE_SCHEMA.unit, "px");
        assert_eq!(LAYER_TREE_SCHEMA.coordinate_system, "page-top-left-y-down");
    }
}
