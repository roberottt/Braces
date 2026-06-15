use crate::ai::provider::{AiError, AiProvider, Context, Token};
use async_trait::async_trait;
use reqwest::Client;
use tokio::sync::mpsc;

pub struct OllamaProvider {
    client: Client,
    host: String,
    model: String,
    embed_model: String,
}

impl OllamaProvider {
    pub fn new(
        host: impl Into<String>,
        model: impl Into<String>,
        embed_model: impl Into<String>,
    ) -> Self {
        Self {
            client: Client::new(),
            host: host.into(),
            model: model.into(),
            embed_model: embed_model.into(),
        }
    }
}

#[async_trait]
impl AiProvider for OllamaProvider {
    async fn complete(
        &self,
        prompt: &str,
        context: &Context,
        stream_tx: mpsc::Sender<Token>,
    ) -> Result<(), AiError> {
        use futures_util::StreamExt;

        // Use /api/chat for multi-turn; system message and history are supported natively
        let url = format!("{}/api/chat", self.host);

        let mut messages: Vec<serde_json::Value> = vec![];
        if let Some(system) = &context.system {
            messages.push(serde_json::json!({ "role": "system", "content": system }));
        }
        for msg in &context.history {
            messages.push(serde_json::json!({ "role": msg.role, "content": msg.content }));
        }
        messages.push(serde_json::json!({ "role": "user", "content": prompt }));

        let body = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "stream": true,
        });

        let resp = self.client.post(&url).json(&body).send().await?;
        let mut stream = resp.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let bytes = chunk?;
            // Each line is a JSON object (Ollama streams newline-delimited JSON)
            for line in String::from_utf8_lossy(&bytes).lines() {
                if line.is_empty() { continue; }
                let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                if let Some(text) = val["message"]["content"].as_str() {
                    if !text.is_empty() {
                        stream_tx
                            .send(Token(text.to_string()))
                            .await
                            .map_err(|_| AiError::StreamClosed)?;
                    }
                }
                if val["done"].as_bool().unwrap_or(false) {
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    async fn embed(&self, text: &str) -> Result<Vec<f32>, AiError> {
        let url = format!("{}/api/embed", self.host);
        let body = serde_json::json!({ "model": self.embed_model, "input": text });
        let resp: serde_json::Value =
            self.client.post(&url).json(&body).send().await?.json().await?;
        let embeddings = resp["embeddings"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|v| v.as_array())
            .ok_or_else(|| AiError::Provider("malformed embed response".into()))?;
        Ok(embeddings
            .iter()
            .filter_map(|v| v.as_f64().map(|f| f as f32))
            .collect())
    }

    fn supports_streaming(&self) -> bool { true }
    fn name(&self) -> &str { "ollama" }
}
