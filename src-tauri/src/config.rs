use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub ai: AiConfig,
    pub providers: HashMap<String, ProviderConfig>,
    pub visual: VisualConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub primary: String,
    pub fallback: Option<String>,
    pub autocomplete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub model: Option<String>,
    pub host: Option<String>,
    pub embed_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisualConfig {
    pub theme: String,
    pub effects: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            ai: AiConfig {
                primary: "ollama".into(),
                fallback: Some("anthropic".into()),
                autocomplete: true,
            },
            providers: {
                let mut m = HashMap::new();
                m.insert("anthropic".into(), ProviderConfig {
                    model: Some("claude-opus-4-8".into()),
                    host: None,
                    embed_model: None,
                });
                m.insert("openai".into(), ProviderConfig {
                    model: Some("gpt-4o-mini".into()),
                    host: None,
                    embed_model: None,
                });
                m.insert("ollama".into(), ProviderConfig {
                    model: Some("llama3.2".into()),
                    host: Some("http://localhost:11434".into()),
                    embed_model: Some("nomic-embed-text".into()),
                });
                m
            },
            visual: VisualConfig {
                theme: "neon-noir".into(),
                effects: true,
            },
        }
    }
}

impl Config {
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let path = Self::config_path();
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(&path)?;
        Ok(toml::from_str(&raw)?)
    }

    fn config_path() -> std::path::PathBuf {
        dirs_next::config_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("braces")
            .join("braces.toml")
    }
}
