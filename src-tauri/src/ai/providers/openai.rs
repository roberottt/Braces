use crate::ai::provider::{
    AgentStep, AiError, AiProvider, Context, Token, ToolCall, ToolDef, ToolResult,
};
use async_trait::async_trait;
use reqwest::Client;
use tokio::sync::mpsc;

pub struct OpenAiProvider {
    client: Client,
    api_key: String,
    model: String,
    base_url: String,
}

impl OpenAiProvider {
    pub fn new(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        Self::with_base(api_key, model, "https://api.openai.com/v1")
    }

    pub fn with_base(
        api_key: impl Into<String>,
        model: impl Into<String>,
        base_url: impl Into<String>,
    ) -> Self {
        Self {
            client: Client::new(),
            api_key: api_key.into(),
            model: model.into(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }
}

#[async_trait]
impl AiProvider for OpenAiProvider {
    async fn complete(
        &self,
        prompt: &str,
        context: &Context,
        stream_tx: mpsc::Sender<Token>,
    ) -> Result<(), AiError> {
        use futures_util::StreamExt;

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

        let resp = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await?;

        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk?;
            let text = String::from_utf8_lossy(&bytes);
            for line in text.lines() {
                let Some(data) = line.strip_prefix("data: ") else { continue };
                if data == "[DONE]" {
                    return Ok(());
                }
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(content) = val["choices"][0]["delta"]["content"].as_str() {
                        if stream_tx.send(Token(content.to_string())).await.is_err() {
                            return Err(AiError::StreamClosed);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    async fn embed(&self, text: &str) -> Result<Vec<f32>, AiError> {
        let body = serde_json::json!({ "model": "text-embedding-3-small", "input": text });
        let resp: serde_json::Value = self
            .client
            .post(format!("{}/embeddings", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;
        let emb = resp["data"][0]["embedding"]
            .as_array()
            .ok_or_else(|| AiError::Provider("malformed embed response".into()))?;
        Ok(emb.iter().filter_map(|v| v.as_f64().map(|f| f as f32)).collect())
    }

    fn supports_streaming(&self) -> bool { true }
    fn name(&self) -> &str { "openai" }

    fn supports_tools(&self) -> bool { true }

    async fn agent_step(
        &self,
        messages: &[serde_json::Value],
        _system: &str,  // already embedded as first message via history_to_messages
        tools: &[ToolDef],
    ) -> Result<AgentStep, AiError> {
        let tools_json: Vec<serde_json::Value> = tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            })
            .collect();

        let body = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "tools": tools_json,
        });

        let resp = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;

        if let Some(err) = resp["error"]["message"].as_str() {
            return Err(AiError::Provider(err.to_string()));
        }

        let choice = &resp["choices"][0];
        let finish = choice["finish_reason"].as_str().unwrap_or("stop");
        let msg = &choice["message"];

        let text = msg["content"].as_str().unwrap_or("").to_string();
        let raw_msg = msg.clone();

        if finish == "tool_calls" {
            let calls: Vec<ToolCall> = msg["tool_calls"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(|tc| {
                    let id = tc["id"].as_str()?.to_string();
                    let name = tc["function"]["name"].as_str()?.to_string();
                    let args: serde_json::Value = serde_json::from_str(
                        tc["function"]["arguments"].as_str().unwrap_or("{}"),
                    )
                    .unwrap_or(serde_json::json!({}));
                    Some(ToolCall { id, name, args })
                })
                .collect();

            Ok(AgentStep::UseTools { text, calls, raw_msg })
        } else {
            Ok(AgentStep::Done(text))
        }
    }

    fn tool_result_messages(&self, results: &[ToolResult]) -> Vec<serde_json::Value> {
        // OpenAI expects one "tool" role message per result
        results
            .iter()
            .map(|r| {
                serde_json::json!({
                    "role": "tool",
                    "tool_call_id": r.call_id,
                    "content": r.output,
                })
            })
            .collect()
    }
}
