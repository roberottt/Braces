use crate::ai::provider::{AiError, AiProvider, Context, Token};
use async_trait::async_trait;
use tokio::sync::mpsc;

pub struct MockProvider {
    pub response: String,
    pub embedding: Vec<f32>,
}

impl Default for MockProvider {
    fn default() -> Self {
        Self {
            response: "mock response".into(),
            embedding: vec![0.1, 0.2, 0.3],
        }
    }
}

#[async_trait]
impl AiProvider for MockProvider {
    async fn complete(
        &self,
        _prompt: &str,
        _context: &Context,
        stream_tx: mpsc::Sender<Token>,
    ) -> Result<(), AiError> {
        for word in self.response.split_whitespace() {
            stream_tx
                .send(Token(format!("{word} ")))
                .await
                .map_err(|_| AiError::StreamClosed)?;
        }
        Ok(())
    }

    async fn embed(&self, _text: &str) -> Result<Vec<f32>, AiError> {
        Ok(self.embedding.clone())
    }

    fn supports_streaming(&self) -> bool {
        true
    }

    fn name(&self) -> &str {
        "mock"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn mock_streams_tokens() {
        let provider = MockProvider::default();
        let (tx, mut rx) = mpsc::channel(32);
        provider.complete("hello", &Context::default(), tx).await.unwrap();

        let mut collected = String::new();
        while let Ok(token) = rx.try_recv() {
            collected.push_str(&token.0);
        }
        assert!(collected.contains("mock"));
    }

    #[tokio::test]
    async fn mock_returns_embedding() {
        let provider = MockProvider::default();
        let emb = provider.embed("test").await.unwrap();
        assert!(!emb.is_empty());
    }
}
