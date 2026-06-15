use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct Token(pub String);

/// A single turn in a multi-turn conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,    // "user" or "assistant"
    pub content: String,
}

#[derive(Debug, Clone, Default)]
pub struct Context {
    /// System / instructions prompt injected before the conversation.
    pub system: Option<String>,
    /// Prior conversation turns (user/assistant pairs).
    pub history: Vec<ChatMessage>,
    pub project_chunks: Vec<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Error)]
pub enum AiError {
    #[error("provider error: {0}")]
    Provider(String),
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("stream closed")]
    StreamClosed,
}

// ── Tool calling types ────────────────────────────────────────────────────────

/// Definition of a callable tool sent to the AI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// JSON Schema object describing the parameters.
    pub parameters: serde_json::Value,
}

/// A single tool invocation requested by the model.
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: serde_json::Value,
}

/// Result of one tool execution, to send back to the model.
#[derive(Debug, Clone)]
pub struct ToolResult {
    pub call_id: String,
    pub output: String,
}

/// What the model returned in one agentic step.
pub enum AgentStep {
    /// Model finished — here is its final text.
    Done(String),
    /// Model wants to call tools. `raw_msg` is the assistant message in
    /// provider-native JSON format (must be appended to the message list).
    UseTools {
        text: String,
        calls: Vec<ToolCall>,
        raw_msg: serde_json::Value,
    },
}

#[async_trait]
pub trait AiProvider: Send + Sync {
    async fn complete(
        &self,
        prompt: &str,
        context: &Context,
        stream_tx: mpsc::Sender<Token>,
    ) -> Result<(), AiError>;

    async fn embed(&self, text: &str) -> Result<Vec<f32>, AiError>;

    fn supports_streaming(&self) -> bool;

    fn name(&self) -> &str;

    // ── Agentic tool-calling API ──────────────────────────────────────────

    /// Whether this provider supports native tool/function calling.
    fn supports_tools(&self) -> bool { false }

    /// One agentic step: send `messages` (provider-native JSON) + tools,
    /// return either a final answer or tool call requests.
    async fn agent_step(
        &self,
        _messages: &[serde_json::Value],
        _system: &str,
        _tools: &[ToolDef],
    ) -> Result<AgentStep, AiError> {
        Err(AiError::Provider(format!(
            "Provider '{}' does not support native tool calling.", self.name()
        )))
    }

    /// Format tool results into provider-native JSON message(s) to append to
    /// the conversation before the next `agent_step` call.
    fn tool_result_messages(&self, _results: &[ToolResult]) -> Vec<serde_json::Value> {
        vec![]
    }

    /// Convert a plain ChatMessage history into provider-native JSON messages.
    /// Providers that override `agent_step` should also override this.
    fn history_to_messages(
        &self,
        system: &str,
        history: &[ChatMessage],
    ) -> Vec<serde_json::Value> {
        let mut msgs = vec![serde_json::json!({ "role": "system", "content": system })];
        for m in history {
            msgs.push(serde_json::json!({ "role": m.role, "content": m.content }));
        }
        msgs
    }
}
