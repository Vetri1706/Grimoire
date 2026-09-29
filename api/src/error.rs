use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

pub struct ApiError(pub StatusCode, pub &'static str, pub String);

impl ApiError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_INTAKE",
            message.into(),
        )
    }
    pub fn unauthorized() -> Self {
        Self(
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
            "A valid Grimoire bearer credential is required.".into(),
        )
    }
    pub fn not_found() -> Self {
        Self(
            StatusCode::NOT_FOUND,
            "SCION_NOT_FOUND",
            "Scion not found.".into(),
        )
    }
    pub fn forbidden() -> Self {
        Self(
            StatusCode::FORBIDDEN,
            "INTAKE_WRITE_DENIED",
            "Your current role cannot edit intake drafts.".into(),
        )
    }
    pub fn stale() -> Self {
        Self(
            StatusCode::PRECONDITION_FAILED,
            "STALE_REVISION",
            "The Scion has a newer revision. Reopen it before saving your changes.".into(),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(json!({"error":{"code":self.1,"message":self.2}})),
        )
            .into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        let code = error.as_database_error().and_then(|e| e.code());
        tracing::error!(sqlstate=?code,"Database request failed");
        match code.as_deref() {
            Some("42501") => Self::forbidden(),
            Some("G2402") => Self::stale(),
            Some("G4301") => Self(StatusCode::CONFLICT,"AGENT_UNAVAILABLE","The agent is paused or its runtime bounds do not allow this task.".into()),
            Some("G4302") => Self(StatusCode::PRECONDITION_FAILED,"AGENT_CONFIG_STALE","This configuration has a newer revision. Reopen it before saving.".into()),
            Some("G2601") => Self(StatusCode::FORBIDDEN,"SOURCE_RIGHTS_DENIED","Source permission has been revoked.".into()),
            Some("G2801") => Self(StatusCode::UNPROCESSABLE_ENTITY,"INVALID_SCOPE","The exact physical scope or evidence binding is incomplete or unavailable.".into()),
            Some("G2802") => Self(StatusCode::CONFLICT,"SCOPE_BLOCKED","The exact scope is ambiguous, incomplete, stale, or bound to mismatched evidence.".into()),
            Some("G2803") => Self(StatusCode::CONFLICT,"SCOPE_ALREADY_CONFIRMED","This Scion already has a confirmed synthetic scope.".into()),
            Some("G2804") => Self(StatusCode::FORBIDDEN,"SCOPE_CONFIRM_DENIED","A distinct enrolled synthetic engineering reviewer is required; agents cannot confirm.".into()),
            Some("G2901") => Self(StatusCode::CONFLICT,"AGENT_TASK_CONFLICT","The task lease, proposal binding, or transition is no longer current.".into()),
            Some("G3201") => Self(StatusCode::UNPROCESSABLE_ENTITY,"INVALID_OFFER","The synthetic offer, supplier/source binding or exact comparison basis is invalid.".into()),
            Some("G3202") => Self(StatusCode::CONFLICT,"COMPARISON_STALE","Comparison inputs changed. Prepare a new immutable normalization proposal.".into()),
            Some("G3203") => Self(StatusCode::CONFLICT,"NORMALIZATION_ALREADY_CONFIRMED","This normalization proposal has already been confirmed.".into()),
            Some("G3204") => Self::not_found(),
            Some("G3301" | "G3302") => Self(StatusCode::FORBIDDEN,"SOURCING_AUTHORITY_DENIED","A valid independent sourcing authority is required.".into()),
            Some("G3303") => Self(StatusCode::CONFLICT,"IDEMPOTENCY_CONFLICT","The retry key has different authority inputs.".into()),
            Some("G3304") => Self::not_found(),
            Some("G3305") => Self(StatusCode::CONFLICT,"SOURCING_INPUT_STALE","The exact sourcing inputs are stale or unavailable.".into()),
            Some("G3801") => Self(StatusCode::UNPROCESSABLE_ENTITY,"INVALID_CAPABILITY_PLAN","The capability plan or evidence comparison is incomplete or invalid.".into()),
            Some("G3802") => Self(StatusCode::CONFLICT,"CAPABILITY_INPUT_STALE","Plan or evidence inputs changed. Prepare a new revision-bound proposal.".into()),
            Some("G3804") => Self::not_found(),
            Some("G3901") => Self(StatusCode::FORBIDDEN,"APPROVAL_UNAVAILABLE","Sourcing approval is disabled on this Windows implementation.".into()),
            Some("23505") => Self(StatusCode::CONFLICT,"IDENTITY_CONFLICT","This identity or operation already exists. Use a new explicit identity or replay the original request.".into()),
            Some("23514") => Self::invalid("An intake value violates its bounds."),
            _ => Self(StatusCode::SERVICE_UNAVAILABLE,"DATABASE_UNAVAILABLE","The database could not complete this request. Retry with the same idempotency key.".into()),
        }
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(_: serde_json::Error) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "The response could not be encoded.".into(),
        )
    }
}
