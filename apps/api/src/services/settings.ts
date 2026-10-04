import { parseConvenienceFeeConfig, type Settings } from "@townplay/shared";
import { SettingsModel } from "../models/settings.js";
import { audit } from "./audit.js";

/** Global admin settings; until an admin saves them, CONVENIENCE_FEE_CONFIG is the default. */
export function createSettingsService(defaultFeeConfig: string | undefined) {
  const defaults: Settings = { convenienceFee: parseConvenienceFeeConfig(defaultFeeConfig) };

  async function get(): Promise<Settings> {
    const doc = await SettingsModel.findById("global").lean();
    if (!doc?.convenienceFee) return defaults;
    return {
      convenienceFee: {
        flatPaise: doc.convenienceFee.flatPaise,
        percent: doc.convenienceFee.percent,
      },
    };
  }

  async function update(actorId: string, next: Settings): Promise<Settings> {
    const before = await get();
    await SettingsModel.updateOne({ _id: "global" }, { $set: next }, { upsert: true });
    await audit(actorId, "settings.update", "settings", "global", { before, after: next });
    return next;
  }

  return { get, update };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
