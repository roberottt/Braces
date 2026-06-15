use super::provider::{AiError, AiProvider, Context, Token};
use async_trait::async_trait;
use std::sync::Arc;
use tokio::sync::mpsc;

pub struct Router {
    primary: Arc<dyn AiProvider>,
    fallback: Option<Arc<dyn AiProvider>>,
}

impl Router {
    pub fn new(primary: Arc<dyn AiProvider>, fallback: Option<Arc<dyn AiProvider>>) -> Self {
        Self { primary, fallback }
    }
}

#[async_trait]
impl AiProvider for Router {
    async fn complete(
        &self,
        prompt: &str,
        context: &Context,
        stream_tx: mpsc::Sender<Token>,
    ) -> Result<(), AiError> {
        let result = self.primary.complete(prompt, context, stream_tx.clone()).await;
        if result.is_err() {
            if let Some(fb) = &self.fallback {
                return fb.complete(prompt, context, stream_tx).await;
            }
        }
        result
    }

    async fn embed(&self, text: &str) -> Result<Vec<f32>, AiError> {
        let result = self.primary.embed(text).await;
        if result.is_err() {
            if let Some(fb) = &self.fallback {
                return fb.embed(text).await;
            }
        }
        result
    }

    fn supports_streaming(&self) -> bool {
        self.primary.supports_streaming()
    }

    fn name(&self) -> &str {
        "router"
    }
}
