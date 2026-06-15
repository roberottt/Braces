use super::openai::OpenAiProvider;
use crate::ai::provider::{AiError, AiProvider, Context, Token};
use async_trait::async_trait;
use tokio::sync::mpsc;

/// LM Studio exposes an OpenAI-compatible API at localhost:1234 by default.
pub struct LmStudioProvider(OpenAiProvider);

impl LmStudioProvider {
    pub fn new(host: impl Into<String>, model: impl Into<String>) -> Self {
        let base = format!("{}/v1", host.into().trim_end_matches('/'));
        Self(OpenAiProvider::with_base("", model, base))
    }
}

#[async_trait]
impl AiProvider for LmStudioProvider {
    async fn complete(&self, prompt: &str, ctx: &Context, tx: mpsc::Sender<Token>) -> Result<(), AiError> {
        self.0.complete(prompt, ctx, tx).await
    }
    async fn embed(&self, text: &str) -> Result<Vec<f32>, AiError> {
        self.0.embed(text).await
    }
    fn supports_streaming(&self) -> bool { true }
    fn name(&self) -> &str { "lmstudio" }
}
