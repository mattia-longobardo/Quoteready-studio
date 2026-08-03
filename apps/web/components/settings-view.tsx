"use client";

import { useMemo, useState } from "react";

import { ArrowIcon } from "@/components/icons";
import { responseMessage } from "@/lib/client-http";
import type { WorkspaceState } from "@quoteredy/core/types";

type PublicSettings = WorkspaceState["settings"];

interface TimezoneOption {
  name: string;
  offsetMinutes: number;
  label: string;
}

function timezoneOffsetMinutes(timeZone: string, reference: Date): number {
  try {
    const value =
      new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "shortOffset" })
        .formatToParts(reference)
        .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    const match = value.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    if (!match) return 0;
    const hours = Number(match[1]);
    const minutes = Number(match[2] ?? 0);
    return hours * 60 + Math.sign(hours) * minutes;
  } catch {
    return 0;
  }
}

function offsetLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

function buildTimezoneOptions(): TimezoneOption[] {
  const reference = new Date();
  return Intl.supportedValuesOf("timeZone")
    .map((name) => {
      const offsetMinutes = timezoneOffsetMinutes(name, reference);
      return {
        name,
        offsetMinutes,
        label: `(${offsetLabel(offsetMinutes)}) ${name.replaceAll("_", " ")}`,
      };
    })
    .sort(
      (a, b) =>
        a.offsetMinutes - b.offsetMinutes || a.name.localeCompare(b.name),
    );
}

export function SettingsView({
  settings,
  refresh,
}: {
  settings: PublicSettings;
  refresh: () => Promise<void>;
}) {
  const [timezone, setTimezone] = useState(settings.timezone);
  const [currency, setCurrency] = useState(settings.currency);
  const [theme, setTheme] = useState(settings.theme);
  const [aiEnabled, setAiEnabled] = useState(settings.aiReports.enabled);
  const [aiModel, setAiModel] = useState(settings.aiReports.model);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [openaiKeyDirty, setOpenaiKeyDirty] = useState(false);
  const [zooApiToken, setZooApiToken] = useState("");
  const [zooTokenDirty, setZooTokenDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const timezones = useMemo(() => buildTimezoneOptions(), []);
  const currencies = useMemo(() => {
    try {
      return Intl.supportedValuesOf("currency");
    } catch {
      return ["EUR", "USD", "GBP", "CHF", "JPY"];
    }
  }, []);

  async function save() {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const body: Record<string, unknown> = {
        timezone,
        currency,
        theme,
        aiReportsEnabled: aiEnabled,
        aiModel: aiModel.trim(),
      };
      if (openaiKeyDirty) body.openaiApiKey = openaiApiKey.trim();
      if (zooTokenDirty) body.zooApiToken = zooApiToken.trim();
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "Settings could not be saved."),
        );
      setOpenaiApiKey("");
      setOpenaiKeyDirty(false);
      setZooApiToken("");
      setZooTokenDirty(false);
      setMessage("Settings saved.");
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Settings could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="standard-view settings-page">
      <div className="view-title">
        <div>
          <span>WORKSPACE PREFERENCES</span>
          <h1>Settings</h1>
          <p>
            Personal preferences and integrations for your workspace. Values are
            stored per Zoo account; API keys are encrypted at rest and never
            shown again.
          </p>
        </div>
      </div>

      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="upload-success" role="status">
          {message}
        </div>
      )}

      <section className="technical-panel settings-block">
        <div className="panel-heading">
          <div>
            <span className="step-number">01</span>
            <div>
              <small>LOCALIZATION</small>
              <h2>Time &amp; currency</h2>
            </div>
          </div>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>Timezone</span>
            <select
              onChange={(event) => setTimezone(event.target.value)}
              value={timezone}
            >
              {timezones.map((zone) => (
                <option key={zone.name} value={zone.name}>
                  {zone.label}
                </option>
              ))}
            </select>
            <small>Sorted by UTC offset. Used for every date shown here.</small>
          </label>
          <label className="field">
            <span>Currency</span>
            <select
              onChange={(event) => setCurrency(event.target.value)}
              value={currency}
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <small>
              All estimates are still computed and shown in EUR (server region).
              Dynamic geo-based pricing is on the roadmap.
            </small>
          </label>
          <label className="field">
            <span>Theme</span>
            <select
              onChange={(event) =>
                setTheme(event.target.value as PublicSettings["theme"])
              }
              value={theme}
            >
              <option value="system">Sync with device</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
            <small>“Sync with device” follows your OS appearance.</small>
          </label>
        </div>
      </section>

      <section className="technical-panel settings-block">
        <div className="panel-heading">
          <div>
            <span className="step-number">02</span>
            <div>
              <small>DETAILED REPORTS (OPENAI)</small>
              <h2>AI report generation</h2>
            </div>
          </div>
          <span>{aiEnabled ? "Enabled" : "Disabled"}</span>
        </div>
        <div className="form-grid">
          <label className="field toggle-field">
            <span>Detailed reports</span>
            <span className="toggle-row">
              <input
                checked={aiEnabled}
                onChange={(event) => setAiEnabled(event.target.checked)}
                type="checkbox"
              />
              Generate detailed PDF reports from analysis results
            </span>
            <small>
              Enabled by default. Generation runs with your own OpenAI API key.
            </small>
          </label>
          <label className="field">
            <span>OpenAI model</span>
            <input
              maxLength={80}
              onChange={(event) => setAiModel(event.target.value)}
              placeholder="gpt-4o"
              value={aiModel}
            />
          </label>
          <label className="field wide">
            <span>
              OpenAI API key{" "}
              {settings.hasAiApiKey && (
                <em className="key-state">configured</em>
              )}
            </span>
            <input
              autoComplete="off"
              maxLength={400}
              onChange={(event) => {
                setOpenaiApiKey(event.target.value);
                setOpenaiKeyDirty(true);
              }}
              placeholder={
                settings.hasAiApiKey
                  ? "Leave blank to keep the stored key — type to replace, save empty to remove"
                  : "sk-…"
              }
              type="password"
              value={openaiApiKey}
            />
          </label>
        </div>
      </section>

      <section className="technical-panel settings-block">
        <div className="panel-heading">
          <div>
            <span className="step-number">03</span>
            <div>
              <small>ZOO PROJECTS API</small>
              <h2>Zoo library connection</h2>
            </div>
          </div>
          <span>{settings.hasZooApiToken ? "Connected" : "Not connected"}</span>
        </div>
        <div className="form-grid">
          <label className="field wide">
            <span>
              Zoo API token{" "}
              {settings.hasZooApiToken && (
                <em className="key-state">configured</em>
              )}
            </span>
            <input
              autoComplete="off"
              maxLength={400}
              onChange={(event) => {
                setZooApiToken(event.target.value);
                setZooTokenDirty(true);
              }}
              placeholder={
                settings.hasZooApiToken
                  ? "Leave blank to keep the stored token — type to replace, save empty to remove"
                  : "Personal token from zoo.dev → account → API tokens"
              }
              type="password"
              value={zooApiToken}
            />
            <small>
              Zoo&apos;s Projects API does not accept third-party OAuth tokens,
              so the library and CAD upload need a personal API token. It is
              used only when it belongs to the Zoo account you signed in with.
            </small>
          </label>
        </div>
      </section>

      <div className="panel-actions settings-save">
        <button
          className="primary-button"
          disabled={saving}
          onClick={() => void save()}
          type="button"
        >
          {saving ? "Saving…" : "Save settings"}
          <ArrowIcon />
        </button>
      </div>
    </div>
  );
}
