import { Component } from "solid-js";
import { store } from "../store/terminalStore";
import { t } from "../i18n";

type Props = { cwd: string };

const Key = (p: { k: string }) => <span class="nsw-key">{p.k}</span>;

const NewSessionWelcome: Component<Props> = (props) => {
  const shortcuts = () => [
    { keys: ["ctrl", "alt", "T"],   desc: t(store.language, "shortcut_new_tab")     },
    { keys: ["ctrl", "shift", "A"], desc: t(store.language, "shortcut_ai_panel")    },
    { keys: ["ctrl", "R"],          desc: t(store.language, "shortcut_history")     },
    { keys: ["ctrl", ","],          desc: t(store.language, "shortcut_settings")    },
    { keys: ["ctrl", "shift", "M"], desc: t(store.language, "shortcut_metrics")     },
  ];

  const shortCwd = () => {
    const c = props.cwd || "~";
    const parts = c.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : c;
  };

  return (
    <div class="nsw">
      <div class="nsw-header">

        {/* Eye image: rendered tiny then scaled up for pixel-art look */}
        <div class="nsw-eye-wrap">
          <img
            src="/splash-eye.png"
            class="nsw-eye-img"
            alt=""
            draggable={false}
          />
        </div>

        <div class="nsw-title-block">
          <div class="nsw-title">◈ NEW SESSION</div>
          <div class="nsw-subtitle">Braces — AI-Native Terminal</div>
          <div class="nsw-cwd">
            <span class="nsw-cwd-icon">⬡</span>
            {shortCwd()}
          </div>
        </div>
      </div>

      <div class="nsw-divider" />

      <div class="nsw-shortcuts">
        {shortcuts().map(s => (
          <div class="nsw-row">
            <span class="nsw-keys">
              {s.keys.map((k, i) => (
                <>{i > 0 && <span class="nsw-plus">+</span>}<Key k={k} /></>
              ))}
            </span>
            <span class="nsw-desc">{s.desc}</span>
          </div>
        ))}
      </div>

      <div class="nsw-hint">{t(store.language, "nsw_hint")}</div>
    </div>
  );
};

export default NewSessionWelcome;
