use crate::ai::provider::{
    AgentStep, AiError, AiProvider, ChatMessage, Context, Token, ToolCall, ToolDef, ToolResult,
};
use async_trait::async_trait;
use reqwest::Client;
use tokio::sync::mpsc;

const ANTHROPIC_API: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_MODEL: &str = "claude-opus-4-8";

pub struct AnthropicProvider {
    client: Client,
    api_key: String,
    model: String,
}

impl AnthropicProvider {
    pub fn new(api_key: impl Into<String>, model: Option<String>) -> Self {
        Self {
            client: Client::new(),
            api_key: api_key.into(),
            model: model.unwrap_or_else(|| DEFAULT_MODEL.into()),
        }
    }
}

#[async_trait]
impl AiProvider for AnthropicProvider {
    async fn complete(
        &self,
        prompt: &str,
        context: &Context,
        stream_tx: mpsc::Sender<Token>,
    ) -> Result<(), AiError> {
        use futures_util::StreamExt;

        // Build messages array: history turns + current user message
        let mut messages: Vec<serde_json::Value> = context
            .history
            .iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect();
        messages.push(serde_json::json!({ "role": "user", "content": prompt }));

        let mut body = serde_json::json!({
            "model": self.model,
            "max_tokens": 2048,
            "stream": true,
            "messages": messages,
        });
        if let Some(system) = &context.system {
            body["system"] = serde_json::json!(system);
        }

        let resp = self
            .client
            .post(ANTHROPIC_API)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;

        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk?;
            let text = String::from_utf8_lossy(&bytes);
            for line in text.lines() {
                let Some(data) = line.strip_prefix("data: ") else { continue };
                let Ok(val) = serde_json::from_str::<serde_json::Value>(data) else { continue };

                if val["type"] == "content_block_delta"
                    && val["delta"]["type"] == "text_delta"
                {
                    if let Some(text) = val["delta"]["text"].as_str() {
                        stream_tx
                            .send(Token(text.to_string()))
                            .await
                            .map_err(|_| AiError::StreamClosed)?;
                    }
                }
                if val["type"] == "message_stop" {
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    async fn embed(&self, _text: &str) -> Result<Vec<f32>, AiError> {
        Err(AiError::Provider(
            "anthropic does not support embeddings; use ollama".into(),
        ))
    }

    fn supports_streaming(&self) -> bool { true }
    fn name(&self) -> &str { "anthropic" }

    fn supports_tools(&self) -> bool { true }

    async fn agent_step(
        &self,
        messages: &[serde_json::Value],
        system: &str,
        tools: &[ToolDef],
    ) -> Result<AgentStep, AiError> {
        let tools_json: Vec<serde_json::Value> = tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters,
                })
            })
            .collect();

        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": 4096,
            "system": system,
            "tools": tools_json,
            "messages": messages,
        });

        let resp = self
            .client
            .post(ANTHROPIC_API)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;

        if let Some(err) = resp["error"]["message"].as_str() {
            return Err(AiError::Provider(err.to_string()));
        }

        let content = resp["content"].as_array().cloned().unwrap_or_default();
        let raw_msg = serde_json::json!({ "role": "assistant", "content": content });

        let mut text = String::new();
        let mut calls: Vec<ToolCall> = Vec::new();

        for block in &content {
            match block["type"].as_str() {
                Some("text") => text.push_str(block["text"].as_str().unwrap_or("")),
                Some("tool_use") => {
                    calls.push(ToolCall {
                        id: block["id"].as_str().unwrap_or("").to_string(),
                        name: block["name"].as_str().unwrap_or("").to_string(),
                        args: block["input"].clone(),
                    });
                }
                _ => {}
            }
        }

        if calls.is_empty() {
            Ok(AgentStep::Done(text))
        } else {
            Ok(AgentStep::UseTools { text, calls, raw_msg })
        }
    }

    fn tool_result_messages(&self, results: &[ToolResult]) -> Vec<serde_json::Value> {
        let content: Vec<serde_json::Value> = results
            .iter()
            .map(|r| {
                serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": r.call_id,
                    "content": r.output,
                })
            })
            .collect();
        vec![serde_json::json!({ "role": "user", "content": content })]
    }

    fn history_to_messages(
        &self,
        _system: &str,
        history: &[ChatMessage],
    ) -> Vec<serde_json::Value> {
        // Anthropic uses a separate system field, not a system message in the array
        history
            .iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect()
    }
}
