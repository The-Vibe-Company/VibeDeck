import type {
  AppState,
  FeedPanel,
  FeedPanelConfigurationDraft,
  MediaGenApi,
} from "./types";

export type {
  FeedConfigurationCustomSource,
  FeedPanelConfigurationDraft,
} from "./types";

type FeedConfigurationApi = Pick<
  MediaGenApi,
  "saveFeedPanelConfiguration"
>;

export async function saveFeedPanelConfiguration(
  api: FeedConfigurationApi,
  panel: FeedPanel,
  _state: AppState,
  draft: FeedPanelConfigurationDraft,
) {
  return api.saveFeedPanelConfiguration(panel.id, draft);
}
