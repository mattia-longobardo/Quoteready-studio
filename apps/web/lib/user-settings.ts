import {
  DEFAULT_USER_SETTINGS,
  type StoredUserSettings,
  type ThemePreference,
  type UserSettings,
} from "@quoteredy/core/types";

import { openCookie, sealCookie } from "@/lib/oauth";
import { RequestInputError } from "@/lib/request-security";
import { requireOAuthConfig } from "@/lib/zoo-auth";

const THEMES: ThemePreference[] = ["system", "light", "dark"];
const MODEL_PATTERN = /^[a-zA-Z0-9._:-]{1,80}$/;
const SECRET_MAX_LENGTH = 400;

export function settingsWithDefaults(
  stored: StoredUserSettings | null,
): StoredUserSettings {
  return {
    timezone: stored?.timezone ?? DEFAULT_USER_SETTINGS.timezone,
    currency: stored?.currency ?? DEFAULT_USER_SETTINGS.currency,
    theme: stored?.theme ?? DEFAULT_USER_SETTINGS.theme,
    aiReports: {
      enabled:
        stored?.aiReports?.enabled ?? DEFAULT_USER_SETTINGS.aiReports.enabled,
      model: stored?.aiReports?.model ?? DEFAULT_USER_SETTINGS.aiReports.model,
    },
    aiApiKeySealed: stored?.aiApiKeySealed ?? null,
    zooApiTokenSealed: stored?.zooApiTokenSealed ?? null,
  };
}

export function publicSettings(
  stored: StoredUserSettings | null,
): UserSettings & { hasAiApiKey: boolean; hasZooApiToken: boolean } {
  const settings = settingsWithDefaults(stored);
  return {
    timezone: settings.timezone,
    currency: settings.currency,
    theme: settings.theme,
    aiReports: settings.aiReports,
    hasAiApiKey: Boolean(settings.aiApiKeySealed),
    hasZooApiToken: Boolean(settings.zooApiTokenSealed),
  };
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isValidCurrency(value: string): boolean {
  try {
    return Intl.supportedValuesOf("currency").includes(value);
  } catch {
    return /^[A-Z]{3}$/.test(value);
  }
}

function sealSecret(value: string): string {
  return sealCookie(value, requireOAuthConfig().sessionSecret);
}

function openSecret(sealed: string | null): string | null {
  if (!sealed) return null;
  try {
    return openCookie<string>(sealed, requireOAuthConfig().sessionSecret);
  } catch {
    return null;
  }
}

export function getOpenAiKey(stored: StoredUserSettings | null): string | null {
  return openSecret(stored?.aiApiKeySealed ?? null);
}

export function getUserZooApiToken(
  stored: StoredUserSettings | null,
): string | null {
  return openSecret(stored?.zooApiTokenSealed ?? null);
}

/**
 * Validate a settings update payload and merge it over the current stored
 * settings. Secrets: undefined = keep, empty string = remove, value = replace
 * (sealed with the server session secret before persistence).
 */
export function applySettingsUpdate(
  current: StoredUserSettings | null,
  body: Record<string, unknown>,
): StoredUserSettings {
  const settings = settingsWithDefaults(current);

  if (body.timezone !== undefined) {
    if (
      typeof body.timezone !== "string" ||
      body.timezone.length > 80 ||
      !isValidTimezone(body.timezone)
    ) {
      throw new RequestInputError("Select a valid timezone.");
    }
    settings.timezone = body.timezone;
  }
  if (body.currency !== undefined) {
    if (typeof body.currency !== "string" || !isValidCurrency(body.currency)) {
      throw new RequestInputError("Select a valid ISO 4217 currency.");
    }
    settings.currency = body.currency;
  }
  if (body.theme !== undefined) {
    if (
      typeof body.theme !== "string" ||
      !THEMES.includes(body.theme as ThemePreference)
    ) {
      throw new RequestInputError("Select a valid theme.");
    }
    settings.theme = body.theme as ThemePreference;
  }
  if (body.aiReportsEnabled !== undefined) {
    if (typeof body.aiReportsEnabled !== "boolean") {
      throw new RequestInputError("aiReportsEnabled must be a boolean.");
    }
    settings.aiReports = {
      ...settings.aiReports,
      enabled: body.aiReportsEnabled,
    };
  }
  if (body.aiModel !== undefined) {
    if (typeof body.aiModel !== "string" || !MODEL_PATTERN.test(body.aiModel)) {
      throw new RequestInputError(
        "The model name may only contain letters, digits, dots, dashes, colons and underscores (max 80).",
      );
    }
    settings.aiReports = { ...settings.aiReports, model: body.aiModel };
  }
  for (const [field, target] of [
    ["openaiApiKey", "aiApiKeySealed"],
    ["zooApiToken", "zooApiTokenSealed"],
  ] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > SECRET_MAX_LENGTH) {
      throw new RequestInputError(`${field} is not a valid secret value.`);
    }
    const trimmed = value.trim();
    settings[target] = trimmed ? sealSecret(trimmed) : null;
  }
  return settings;
}
