//! Uniform API error type: JSON `{error, message}` responses.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn not_found(msg: impl Into<String>) -> Self {
        ApiError {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: msg.into(),
        }
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "bad_request",
            message: msg.into(),
        }
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        ApiError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: msg.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error": self.code, "message": self.message})),
        )
            .into_response()
    }
}
