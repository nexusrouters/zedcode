import { create } from "zustand";
import { setZedcodeDynamicModelIds } from "../config";
import {
  fetchZedcodeModels,
  isLoggedIn,
  type ZedcodeModel,
} from "../lib/zedcodeAuth";
import { onKeysChanged } from "@/modules/settings/store";

// After device-flow login the plan model list is fetched from /v1/models and
// exposed here so the model pickers can show it. Login/logout broadcast the
// cross-window keys-changed event (`onKeysChanged`), which we use as the
// trigger to re-fetch — so picking up a fresh session needs no manual reload.

type ZedcodeModelsState = {
  hydrated: boolean;
  loggedIn: boolean;
  models: ZedcodeModel[];
  /** Re-check login state and re-fetch the plan model list. */
  refresh: () => Promise<void>;
  /** One-time init: refresh now + refresh again whenever keys change. */
  hydrate: () => Promise<void>;
};

let initialized = false;

export const useZedcodeModelsStore = create<ZedcodeModelsState>((set) => ({
  hydrated: false,
  loggedIn: false,
  models: [],
  refresh: async () => {
    const loggedIn = await isLoggedIn();
    const models = loggedIn ? await fetchZedcodeModels() : [];
    // Publish the live id set so config.resolveModel/getModel recognise them.
    setZedcodeDynamicModelIds(models.map((m) => m.id));
    set({ loggedIn, models, hydrated: true });
  },
  hydrate: async () => {
    if (initialized) return;
    initialized = true;
    const { refresh } = useZedcodeModelsStore.getState();
    await refresh();
    // Login / logout broadcast the keys-changed event; re-fetch on each.
    void onKeysChanged(() => {
      void useZedcodeModelsStore.getState().refresh();
    });
  },
}));
