import { Component } from "solid-js";
import { store } from "../store/terminalStore";
import { t } from "../i18n";

type Props = { onChoose: (enabled: boolean) => void };

/**
 * One-time prompt for users who completed onboarding before AI command
 * suggestions existed. The first-run wizard offers the choice to new users;
 * without this, everyone else would silently sit on the off default with the
 * toggle only findable in Settings. Shown once — either answer records a
 * preference, so it never appears again.
 */
const AiSuggestionsPrompt: Component<Props> = (props) => {
  const tr = (key: Parameters<typeof t>[1]) => t(store.language, key);

  return (
    <div class="onboarding-overlay" data-tauri-drag-region>
      <div class="onboarding-card">
        <div class="hud-corners">
          <span class="hc-br" />
          <span class="hc-bl" />
        </div>

        <h2>{tr("ai_suggestions")}</h2>
        <p class="ow-sub">{tr("ai_suggestions_prompt_sub")}</p>

        <div class="ow-field">
          <p class="ow-hint">{tr("ai_suggestions_prompt_body")}</p>
          <p class="ow-hint">{tr("ai_suggestions_prompt_note")}</p>
        </div>

        <div class="ow-actions">
          <button class="ow-btn" onClick={() => props.onChoose(false)}>
            {tr("ai_suggestions_prompt_keep_off")}
          </button>
          <button class="ow-btn primary" onClick={() => props.onChoose(true)}>
            {tr("ai_suggestions_prompt_enable")}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AiSuggestionsPrompt;
