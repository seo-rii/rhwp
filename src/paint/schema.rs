/// Versioned root metadata for PageLayerTree JSON and JS-value exports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayerTreeSchema {
    /// Major schema version. This remains an integer for v1 compatibility.
    pub schema_version: u32,
    /// Additive schema revision within the current major version.
    pub schema_minor_version: u32,
    /// Major resource table version. This remains an integer for v1 compatibility.
    pub resource_table_version: u32,
    /// Additive resource-table revision within the current major version.
    pub resource_table_minor_version: u32,
    pub unit: &'static str,
    pub coordinate_system: &'static str,
}

pub const LAYER_TREE_SCHEMA: LayerTreeSchema = LayerTreeSchema {
    schema_version: 1,
    schema_minor_version: 11,
    resource_table_version: 1,
    resource_table_minor_version: 2,
    unit: "px",
    coordinate_system: "page-top-left-y-down",
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_tree_schema_contract_is_stable() {
        assert_eq!(LAYER_TREE_SCHEMA.schema_version, 1);
        assert_eq!(LAYER_TREE_SCHEMA.schema_minor_version, 11);
        assert_eq!(LAYER_TREE_SCHEMA.resource_table_version, 1);
        assert_eq!(LAYER_TREE_SCHEMA.resource_table_minor_version, 2);
        assert_eq!(LAYER_TREE_SCHEMA.unit, "px");
        assert_eq!(LAYER_TREE_SCHEMA.coordinate_system, "page-top-left-y-down");
    }
}
