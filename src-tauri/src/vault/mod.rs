use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use aes_gcm::aead::rand_core::RngCore;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use keyring::Entry;
use thiserror::Error;

const SERVICE: &str = "braces";

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("keyring: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("crypto: {0}")]
    Crypto(String),
    #[error("encoding: {0}")]
    Encoding(#[from] base64::DecodeError),
}

pub struct Vault;

impl Vault {
    /// Store `value` for `provider` key, encrypted with AES-256-GCM.
    pub fn set(provider: &str, value: &str) -> Result<(), VaultError> {
        let key = Aes256Gcm::generate_key(OsRng);
        let cipher = Aes256Gcm::new(&key);
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, value.as_bytes())
            .map_err(|e| VaultError::Crypto(e.to_string()))?;

        // Store: base64(key || nonce || ciphertext)
        let mut blob = Vec::with_capacity(32 + 12 + ciphertext.len());
        blob.extend_from_slice(&key);
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&ciphertext);

        let encoded = B64.encode(&blob);
        Entry::new(SERVICE, provider)?.set_password(&encoded)?;
        Ok(())
    }

    pub fn get(provider: &str) -> Result<String, VaultError> {
        let encoded = Entry::new(SERVICE, provider)?.get_password()?;
        let blob = B64.decode(&encoded)?;
        if blob.len() < 44 {
            return Err(VaultError::Crypto("blob too short".into()));
        }
        let (key_bytes, rest) = blob.split_at(32);
        let (nonce_bytes, ciphertext) = rest.split_at(12);

        let cipher = Aes256Gcm::new_from_slice(key_bytes)
            .map_err(|e| VaultError::Crypto(e.to_string()))?;
        let nonce = Nonce::from_slice(nonce_bytes);
        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| VaultError::Crypto(e.to_string()))?;

        String::from_utf8(plaintext).map_err(|e| VaultError::Crypto(e.to_string()))
    }

    pub fn has(provider: &str) -> bool {
        Entry::new(SERVICE, provider)
            .ok()
            .and_then(|e| e.get_password().ok())
            .is_some()
    }
}
