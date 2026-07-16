use serde::Serialize;
use std::fmt::{Display, Formatter};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl ApiError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_request", message, false)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new("revision_conflict", message, true)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message, false)
    }

    pub fn busy() -> Self {
        Self::new(
            "service_busy",
            "Le moteur local est momentanément occupé.",
            true,
        )
    }

    pub fn unavailable(service: &str) -> Self {
        Self::new(
            "service_unavailable",
            format!("Le service local {service} n'est pas encore disponible."),
            true,
        )
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new("network_error", message, true)
    }

    pub fn unsafe_network(message: impl Into<String>) -> Self {
        Self::new("unsafe_network_target", message, false)
    }

    pub fn cancelled() -> Self {
        Self::new("cancelled", "Téléchargement interrompu.", true)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal_error", message, false)
    }

    pub fn forbidden() -> Self {
        Self::new(
            "forbidden_webview",
            "Cette commande est réservée à l'interface locale VibeDeck.",
            false,
        )
    }

    fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }
}

impl Display for ApiError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ApiError {}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        Self::internal(format!("Erreur de persistance locale: {error}"))
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> Self {
        Self::internal(format!("Erreur de données locales: {error}"))
    }
}
