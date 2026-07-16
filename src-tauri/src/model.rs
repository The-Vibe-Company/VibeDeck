use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const FIRST_PAGE_SIZE: u16 = 48;
pub const MAX_PAGE_SIZE: u16 = 200;
pub const MAX_PATCH_BYTES: usize = 256 * 1024;
pub const MAX_SEARCH_RESULTS: u16 = 200;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DashboardState {
    pub layout: Option<LayoutNode>,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum LayoutNode {
    Panel {
        panel_id: Uuid,
    },
    Split {
        id: Uuid,
        direction: SplitDirection,
        ratio: f64,
        children: [Box<LayoutNode>; 2],
    },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SplitDirection {
    Row,
    Column,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Panel {
    Feed {
        id: Uuid,
        name: String,
        source_ids: Vec<Uuid>,
        default_refresh_interval_seconds: u32,
    },
    Web {
        id: Uuid,
        name: String,
        url: String,
    },
}

impl Panel {
    pub fn id(&self) -> Uuid {
        match self {
            Self::Feed { id, .. } | Self::Web { id, .. } => *id,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: Uuid,
    pub name: String,
    pub input_url: String,
    pub feed_url: String,
    pub connector_id: Option<String>,
    pub connector_kind: ConnectorKind,
    pub refresh_interval_seconds: u32,
    pub status: SourceStatus,
    pub last_checked_at: Option<String>,
    pub last_success_at: Option<String>,
    pub error_message: Option<String>,
    pub baseline_completed_at: Option<String>,
    pub consecutive_failures: u32,
    pub next_retry_at: Option<String>,
    pub due_at_ms: i64,
    pub item_count: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectorKind {
    Rss,
    Atom,
    NewsSitemap,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SourceStatus {
    Idle,
    Refreshing,
    Healthy,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub id: Uuid,
    pub source_id: Uuid,
    pub canonical_url: String,
    pub title: String,
    pub summary: Option<String>,
    pub image_url: Option<String>,
    pub published_at: Option<String>,
    pub updated_at: Option<String>,
    pub first_seen_at: String,
    pub observed_at: String,
    pub arrival_batch_at: String,
    pub last_seen_at: String,
    pub is_baseline: bool,
    pub is_new: bool,
    pub seen_at: Option<String>,
    pub opened_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeedPage {
    pub revision: u64,
    pub items: Vec<FeedItem>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResponse {
    pub session_id: Uuid,
    pub revision: u64,
    pub dashboard: DashboardState,
    pub panels: Vec<Panel>,
    pub sources: Vec<Source>,
    pub first_page_by_panel: BTreeMap<Uuid, FeedPage>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeedPageRequest {
    pub panel_id: Uuid,
    pub cursor: Option<String>,
    pub limit: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub query: String,
    pub panel_id: Option<Uuid>,
    pub mode: SearchMode,
    pub limit: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchStatus {
    pub lexical_ready: bool,
    pub semantic_ready: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    Lexical,
    Semantic,
    Hybrid,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub item: FeedItem,
    pub score_micros: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MutateRequest {
    pub operation_id: Uuid,
    pub expected_revision: u64,
    pub command: MutationCommand,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum CreatePanelInput {
    Feed {
        name: String,
        default_refresh_interval_seconds: Option<u32>,
    },
    Web {
        name: String,
        url: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PanelPlacement {
    pub target_panel_id: Uuid,
    pub side: PlacementSide,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenericSourceInput {
    pub name: String,
    pub input_url: String,
    pub feed_url: String,
    pub connector_kind: ConnectorKind,
    pub refresh_interval_seconds: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectorPreference {
    Auto,
    Rss,
    Atom,
    NewsSitemap,
}

impl ConnectorPreference {
    pub fn connector_kind(self) -> Option<ConnectorKind> {
        match self {
            Self::Auto => None,
            Self::Rss => Some(ConnectorKind::Rss),
            Self::Atom => Some(ConnectorKind::Atom),
            Self::NewsSitemap => Some(ConnectorKind::NewsSitemap),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedConfigurationCustomSource {
    pub url: String,
    pub connector_kind: ConnectorPreference,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedPanelConfigurationDraft {
    pub name: String,
    pub default_refresh_interval_seconds: u32,
    pub kept_source_ids: Vec<Uuid>,
    pub selected_catalog_ids: Vec<String>,
    pub custom_sources: Vec<FeedConfigurationCustomSource>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveFeedPanelConfigurationRequest {
    pub operation_id: Uuid,
    pub expected_revision: u64,
    pub panel_id: Uuid,
    pub draft: FeedPanelConfigurationDraft,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlacementSide {
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "command",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MutationCommand {
    CreatePanel {
        input: CreatePanelInput,
        placement: Option<PanelPlacement>,
    },
    DeletePanel {
        panel_id: Uuid,
    },
    SetWebPanelUrl {
        panel_id: Uuid,
        url: String,
    },
    SetFeedPanelDefaultRefresh {
        panel_id: Uuid,
        refresh_interval_seconds: u32,
    },
    AddGenericSource {
        panel_id: Uuid,
        source: GenericSourceInput,
        position: Option<u16>,
    },
    AttachSource {
        panel_id: Uuid,
        source_id: Uuid,
        position: Option<u16>,
    },
    DetachSource {
        panel_id: Uuid,
        source_id: Uuid,
    },
    SetLayout {
        layout: Option<LayoutNode>,
    },
    RenamePanel {
        panel_id: Uuid,
        name: String,
    },
    MarkItemsSeen {
        item_ids: Vec<Uuid>,
        at: String,
    },
    MarkItemOpened {
        item_id: Uuid,
        at: String,
    },
    ForceRefreshSource {
        source_id: Uuid,
    },
    ForceRefreshPanel {
        panel_id: Uuid,
    },
    ForceRefreshAll,
    /// This variant is constructed only after the main process has validated
    /// and probed every custom source. Generic renderer mutations cannot
    /// deserialize it and therefore cannot bypass network validation.
    #[serde(skip_deserializing)]
    SaveFeedPanelConfiguration {
        panel_id: Uuid,
        name: String,
        default_refresh_interval_seconds: u32,
        kept_source_ids: Vec<Uuid>,
        new_sources: Vec<GenericSourceInput>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RefreshScope {
    Source { source_id: Uuid },
    Panel { panel_id: Uuid },
    All,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MutationAck {
    pub operation_id: Uuid,
    pub committed_revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatePatch {
    pub session_id: Uuid,
    pub base_revision: u64,
    pub revision: u64,
    pub operation_id: Uuid,
    pub changes: Vec<StateChange>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StateChange {
    Dashboard {
        dashboard: DashboardState,
    },
    PanelUpsert {
        panel: Panel,
    },
    PanelRemove {
        panel_id: Uuid,
    },
    SourceUpsert {
        source: Source,
    },
    ItemsUpsert {
        items: Vec<FeedItem>,
    },
    ItemsReadState {
        items: Vec<ItemReadState>,
    },
    PanelInvalidated {
        panel_id: Uuid,
        reason: String,
    },
    RefreshScheduled {
        scope: RefreshScope,
        source_count: u32,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItemReadState {
    pub item_id: Uuid,
    pub seen_at: Option<String>,
    pub opened_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StateStreamMessage {
    Patch {
        patch: StatePatch,
    },
    ResyncRequired {
        session_id: Uuid,
        current_revision: u64,
        reason: String,
    },
    SearchStatus {
        status: SearchStatus,
    },
}

#[derive(Clone, Debug)]
pub struct MutationResult {
    pub ack: MutationAck,
    pub patch: Option<StatePatch>,
}

#[cfg(test)]
mod tests {
    use super::{MutationCommand, RefreshScope, SearchStatus, StateChange, StateStreamMessage};
    use uuid::Uuid;

    #[test]
    fn search_status_channel_contract_is_stable_and_camel_cased() {
        assert_eq!(
            serde_json::to_value(StateStreamMessage::SearchStatus {
                status: SearchStatus {
                    lexical_ready: true,
                    semantic_ready: false,
                },
            })
            .unwrap(),
            serde_json::json!({
                "type": "searchStatus",
                "status": {
                    "lexicalReady": true,
                    "semanticReady": false,
                },
            })
        );
    }

    #[test]
    fn manual_refresh_contract_is_typed_minimal_and_camel_cased() {
        let panel_id = Uuid::parse_str("018f03d8-6d67-7b14-8ca8-407d67398b01").unwrap();
        assert_eq!(
            serde_json::to_value(MutationCommand::ForceRefreshAll).unwrap(),
            serde_json::json!({ "command": "forceRefreshAll" })
        );
        assert_eq!(
            serde_json::to_value(StateChange::RefreshScheduled {
                scope: RefreshScope::Panel { panel_id },
                source_count: 2,
            })
            .unwrap(),
            serde_json::json!({
                "kind": "refreshScheduled",
                "scope": {
                    "kind": "panel",
                    "panelId": panel_id,
                },
                "sourceCount": 2,
            })
        );
    }

    #[test]
    fn prepared_feed_configuration_cannot_be_deserialized_from_renderer_json() {
        let panel_id = Uuid::parse_str("018f03d8-6d67-7b14-8ca8-407d67398b01").unwrap();
        let renderer_attempt = serde_json::json!({
            "command": "saveFeedPanelConfiguration",
            "panelId": panel_id,
            "name": "Fil",
            "defaultRefreshIntervalSeconds": 60,
            "keptSourceIds": [],
            "newSources": [],
        });
        assert!(serde_json::from_value::<MutationCommand>(renderer_attempt).is_err());
    }
}
