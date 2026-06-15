use crate::ai::provider::{AiError, AiProvider, Context, Token};
use async_trait::async_trait;
use reqwest::Client;
use tokio::sync::mpsc;

pub struct GeminiProvider {
    client: Client,
    api_key: String,
    model: String,
}

impl GeminiProvider {
    pub fn new(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        Self { client: Client::new(), api_key: api_key.into(), model: model.into() }
    }
}

#[async_trait]
impl AiProvider for GeminiProvider {
    async fn complete(
        &self,
        prompt: &str,
        context: &Context,
        stream_tx: mpsc::Sender<Token>,
    ) -> Result<(), AiError> {
        use futures_util::StreamExt;

        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
            self.model, self.api_key
        );

        // Gemini uses "model" for the assistant role
        let mut contents: Vec<serde_json::Value> = context
            .history
            .iter()
            .map(|m| {
                let role = if m.role == "assistant" { "model" } else { "user" };
                serde_json::json!({ "role": role, "parts": [{ "text": m.content }] })
            })
            .collect();
        contents.push(serde_json::json!({ "role": "user", "parts": [{ "text": prompt }] }));

        let mut body = serde_json::json!({
            "contents": contents,
            "generationConfig": { "maxOutputTokens": 2048 }
        });
        if let Some(system) = &context.system {
            body["systemInstruction"] =
                serde_json::json!({ "parts": [{ "text": system }] });
        }

        let resp = self.client.post(&url).json(&body).send().await?;
        let mut stream = resp.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let bytes = chunk?;
            let text = String::from_utf8_lossy(&bytes);
            for line in text.lines() {
                let Some(data) = line.strip_prefix("data: ") else { continue };
                if data == "[DONE]" { return Ok(()); }
                let Ok(val) = serde_json::from_str::<serde_json::Value>(data) else { continue };
                if let Some(t) = val["candidates"][0]["content"]["parts"][0]["text"].as_str() {
                    if stream_tx.send(Token(t.to_string())).await.is_err() {
                        return Err(AiError::StreamClosed);
                    }
                }
            }
        }
        Ok(())
    }

    async fn embed(&self, _text: &str) -> Result<Vec<f32>, AiError> {
        Err(AiError::Provider("use ollama for embeddings".into()))
    }
    fn supports_streaming(&self) -> bool { true }
    fn name(&self) -> &str { "gemini" }
}
