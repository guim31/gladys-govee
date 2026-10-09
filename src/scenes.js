// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// Colour, white tone and brightness are already Gladys scene actions on the
// light features; what Gladys cannot reach otherwise are the Govee built-in
// scenes: `run_govee_scene` starts one on a LAN light.
// -----------------------------------------------------------------------------

import { SCENES } from './presets.js';

export const SCENE_ACTIONS = {
  async run_govee_scene(hub, { fields }) {
    if (!SCENES.some((scene) => scene.value === fields.scene)) {
      throw new Error(`Unknown Govee scene "${fields.scene}"`);
    }
    await hub.applyScene(fields.device, fields.scene);
    return {};
  },
};
