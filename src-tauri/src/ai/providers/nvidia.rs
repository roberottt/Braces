use super::openai::OpenAiProvider;
use crate::ai::provider::{AiError, AiProvider, Context, Token};
use async_trait::async_trait;
use tokio::sync::mpsc;

/// NVIDIA NIM (build.nvidia.com) — OpenAI-compatible at integrate.api.nvidia.com/v1
pub struct NvidiaProvider(OpenAiProvider);

impl NvidiaProvider {
    pub fn new(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        Self(OpenAiProvider::with_base(
            api_key,
            model,
            "https://integrate.api.nvidia.com/v1",
        ))
    }
}

#[async_trait]
impl AiProvider for NvidiaProvider {
    async fn complete(&self, prompt: &str, ctx: &Context, tx: mpsc::Sender<Token>) -> Result<(), AiError> {
        self.0.complete(prompt, ctx, tx).await
    }
    async fn embed(&self, text: &str) -> Result<Vec<f32>, AiError> {
        self.0.embed(text).await
    }
    fn supports_streaming(&self) -> bool { true }
    fn name(&self) -> &str { "nvidia" }
}
