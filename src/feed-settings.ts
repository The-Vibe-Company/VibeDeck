import type {
  AppState,
  FeedPanel,
  FeedPanelConfigurationDraft,
  VibeDeckApi,
} from "./types";

export type {
  FeedConfigurationCustomSource,
  FeedPanelConfigurationDraft,
} from "./types";

type FeedConfigurationApi = Pick<
  VibeDeckApi,
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
