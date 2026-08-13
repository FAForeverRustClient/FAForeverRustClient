//! Small, shared JSON:API transport and relationship primitives.
//!
//! FAF's data endpoints all use the same document envelope. Keeping that
//! envelope here prevents each feature client from quietly developing a
//! different parser or error policy.

use std::collections::HashMap;

use futures_util::StreamExt as _;
use serde::Deserialize;
use serde_json::Value;

use crate::ports::RequestError;

/// API documents should be measured in kilobytes or a few megabytes. A hard
/// ceiling prevents a broken proxy/server from turning `Response::text()` into
/// an unbounded allocation while still leaving ample room for relationship-
/// heavy vault pages.
const MAX_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct JsonApiDoc {
    #[serde(default)]
    pub(crate) data: Vec<JsonApiResource>,
    #[serde(default)]
    pub(crate) included: Vec<JsonApiResource>,
    #[serde(default)]
    pub(crate) meta: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct JsonApiResource {
    #[serde(rename = "type")]
    pub(crate) kind: String,
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) attributes: Value,
    #[serde(default)]
    pub(crate) relationships: Value,
}

pub(crate) type ResourceIndex<'a> = HashMap<(String, String), &'a JsonApiResource>;

pub(crate) async fn fetch_document(
    http: &reqwest::Client,
    url: url::Url,
    token: &str,
) -> Result<JsonApiDoc, String> {
    fetch_document_typed(http, url, token)
        .await
        .map_err(|error| error.to_string())
}

/// Fetch one JSON:API document without erasing the recovery category.
///
/// Existing adapters keep using [`fetch_document`] until they migrate as a
/// complete vertical slice; this avoids a flag-day change across every port.
pub(crate) async fn fetch_document_typed(
    http: &reqwest::Client,
    url: url::Url,
    token: &str,
) -> Result<JsonApiDoc, RequestError> {
    let response = http
        .get(url.clone())
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/vnd.api+json")
        .send()
        .await
        .map_err(request_error)?;
    let status = response.status();
    let body = bounded_document_body(response).await?;
    if !status.is_success() {
        return Err(response_error(status, url.path(), &body));
    }
    serde_json::from_str(&body)
        .map_err(|error| RequestError::unexpected(format!("invalid server response: {error}")))
}

fn request_error(error: reqwest::Error) -> RequestError {
    if error.is_connect() || error.is_timeout() || error.is_body() {
        RequestError::offline("Could not reach FAF services. Check your connection and try again.")
    } else {
        RequestError::unexpected(format!("request could not be completed: {error}"))
    }
}

fn response_error(status: reqwest::StatusCode, path: &str, body: &str) -> RequestError {
    let detail = api_error_detail(body);
    match status {
        reqwest::StatusCode::UNAUTHORIZED => {
            RequestError::unauthorized("Your FAF session has expired. Sign out and sign in again.")
        }
        reqwest::StatusCode::NOT_FOUND => {
            RequestError::not_found(format!("The FAF resource at {path} was not found."))
        }
        status if status.is_server_error() => RequestError::offline(
            "FAF services are temporarily unavailable. Please try again shortly.",
        ),
        status if status.is_client_error() => RequestError::rejected(
            detail.unwrap_or_else(|| format!("FAF rejected the request ({status}).")),
        ),
        _ => RequestError::unexpected(format!("FAF returned an unexpected status ({status}).")),
    }
}

/// The JSON:API media type. Required on writes: the API rejects a body sent
/// as `application/json`.
const MEDIA_TYPE: &str = "application/vnd.api+json";

/// Create a resource, returning the document the server echoed back.
///
/// The first *write* path in this client; every other API client here reads.
/// `attributes` is the resource's own fields: the caller supplies the type
/// and the URL decides the parent.
pub(crate) async fn post_resource(
    http: &reqwest::Client,
    url: url::Url,
    token: &str,
    resource_type: &str,
    attributes: Value,
) -> Result<JsonApiDoc, String> {
    let body = serde_json::json!({
        "data": { "type": resource_type, "attributes": attributes },
    });
    let response = http
        .post(url.clone())
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, MEDIA_TYPE)
        .header(reqwest::header::ACCEPT, MEDIA_TYPE)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    write_response(url.path(), response).await
}

/// Update a resource in place. JSON:API requires the id inside the body as
/// well as in the URL, and the server rejects the request if they disagree.
pub(crate) async fn patch_resource(
    http: &reqwest::Client,
    url: url::Url,
    token: &str,
    resource_type: &str,
    id: &str,
    attributes: Value,
) -> Result<(), String> {
    let body = serde_json::json!({
        "data": { "type": resource_type, "id": id, "attributes": attributes },
    });
    let response = http
        .patch(url.clone())
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, MEDIA_TYPE)
        .header(reqwest::header::ACCEPT, MEDIA_TYPE)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    write_response(url.path(), response).await.map(|_| ())
}

pub(crate) async fn delete_resource(
    http: &reqwest::Client,
    url: url::Url,
    token: &str,
) -> Result<(), String> {
    let response = http
        .delete(url.clone())
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, MEDIA_TYPE)
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    write_response(url.path(), response).await.map(|_| ())
}

/// Interpret a write response.
///
/// A successful write may legitimately return no body (`204`), so an empty
/// response is an empty document rather than a parse error. A failure carries
/// JSON:API `errors`, which say far more than the status code: "you already
/// reviewed this" instead of "422".
async fn write_response(path: &str, response: reqwest::Response) -> Result<JsonApiDoc, String> {
    let status = response.status();
    let body = bounded_document_body(response)
        .await
        .map_err(|error| error.to_string())?;

    if !status.is_success() {
        return Err(match api_error_detail(&body) {
            Some(detail) => detail,
            None => format!(
                "{path} returned {status}: {}",
                body.chars().take(240).collect::<String>()
            ),
        });
    }
    if body.trim().is_empty() {
        return Ok(JsonApiDoc::default());
    }
    serde_json::from_str(&body).map_err(|error| format!("invalid JSON: {error}"))
}

async fn bounded_document_body(response: reqwest::Response) -> Result<String, RequestError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DOCUMENT_BYTES)
    {
        return Err(RequestError::unexpected(
            "FAF returned a response that is too large to process safely.",
        ));
    }

    let mut bytes = Vec::new();
    let mut received = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(request_error)?;
        received = received
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| RequestError::unexpected("FAF returned an oversized response."))?;
        if received > MAX_DOCUMENT_BYTES {
            return Err(RequestError::unexpected(
                "FAF returned a response that is too large to process safely.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }

    String::from_utf8(bytes)
        .map_err(|_| RequestError::unexpected("FAF returned a response that was not valid UTF-8."))
}

/// Pull the human-readable half out of a JSON:API error document.
pub(crate) fn api_error_detail(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let errors = value.get("errors")?.as_array()?;
    let messages: Vec<String> = errors
        .iter()
        .filter_map(|error| {
            error
                .get("detail")
                .or_else(|| error.get("title"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
        .collect();
    (!messages.is_empty()).then(|| messages.join("; "))
}

pub(crate) fn resource_index(included: &[JsonApiResource]) -> ResourceIndex<'_> {
    included
        .iter()
        .map(|resource| ((resource.kind.clone(), resource.id.clone()), resource))
        .collect()
}

pub(crate) fn document_index(doc: &JsonApiDoc) -> ResourceIndex<'_> {
    resource_index(&doc.included)
}

pub(crate) fn rel_target(relationships: &Value, name: &str) -> Option<(String, String)> {
    let data = relationships.get(name)?.get("data")?;
    if data.is_null() {
        return None;
    }
    Some((
        data.get("type")?.as_str()?.to_string(),
        data.get("id")?.as_str()?.to_string(),
    ))
}

pub(crate) fn rel_targets(relationships: &Value, name: &str) -> Vec<(String, String)> {
    relationships
        .get(name)
        .and_then(|relationship| relationship.get("data"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            Some((
                value.get("type")?.as_str()?.to_string(),
                value.get("id")?.as_str()?.to_string(),
            ))
        })
        .collect()
}

pub(crate) fn rel_one(resource: &JsonApiResource, name: &str) -> Option<(String, String)> {
    rel_target(&resource.relationships, name)
}

// ── Attribute readers ────────────────────────────────────────────────────────
//
// FAF's API is not consistently typed: the same logical field arrives as a JSON
// number from one endpoint and a quoted string from another, and Challonge's
// proxied objects add a third shape again. Each feature client grew its own
// copy of these, and the copies had *already* drifted: maps and mods accepted
// floats but not strings, tournaments accepted strings but not floats, and only
// maps read a number back as a string.
//
// These are the union of what those copies tolerated. Being more permissive
// than any single previous reader is the safe direction: the alternative to
// parsing a `"24"` is silently reporting zero.

/// An integer attribute, from a JSON number, a float (rounded), or a numeric
/// string. `None` when absent, null, or unparseable.
pub(crate) fn value_i32(attributes: &Value, name: &str) -> Option<i32> {
    let value = attributes.get(name)?;
    value
        .as_i64()
        .and_then(|number| i32::try_from(number).ok())
        .or_else(|| {
            value.as_f64().and_then(|number| {
                let rounded = number.round();
                (rounded.is_finite()
                    && rounded >= f64::from(i32::MIN)
                    && rounded <= f64::from(i32::MAX))
                .then_some(rounded as i32)
            })
        })
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
}

/// A string attribute, rendering a numeric one as text. Empty when absent.
pub(crate) fn value_string(attributes: &Value, name: &str) -> String {
    attributes
        .get(name)
        .and_then(|value| match value {
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

/// A boolean attribute, accepting the `0`/`1` some endpoints send. `false` when
/// absent: every caller treats a missing flag as not set.
pub(crate) fn value_bool(attributes: &Value, name: &str) -> bool {
    attributes
        .get(name)
        .and_then(|value| {
            value
                .as_bool()
                .or_else(|| value.as_i64().map(|number| number != 0))
        })
        .unwrap_or(false)
}

pub(crate) fn rel_many(resource: &JsonApiResource, name: &str) -> Vec<(String, String)> {
    rel_targets(&resource.relationships, name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexes_included_resources_and_reads_relationships() {
        let doc: JsonApiDoc = serde_json::from_str(
            r#"{
                "data": [],
                "included": [{
                    "type": "player",
                    "id": "7",
                    "attributes": { "login": "Example" },
                    "relationships": {
                        "clan": { "data": { "type": "clan", "id": "2" } },
                        "games": { "data": [
                            { "type": "game", "id": "3" },
                            { "type": "game", "id": "4" }
                        ] }
                    }
                }]
            }"#,
        )
        .expect("valid document");

        let index = document_index(&doc);
        let player = index
            .get(&("player".to_string(), "7".to_string()))
            .expect("player indexed");
        assert_eq!(rel_one(player, "clan"), Some(("clan".into(), "2".into())));
        assert_eq!(rel_many(player, "games").len(), 2);
    }

    #[test]
    fn an_integer_is_read_from_every_shape_the_api_sends() {
        let attributes = serde_json::json!({
            "number": 24,
            "float": 23.6,
            "tooLarge": 2147483648_i64,
            "tooSmall": -2147483649_i64,
            "text": "24",
            "padded": " 24 ",
            "nothing": null,
            "junk": "many",
        });
        assert_eq!(value_i32(&attributes, "number"), Some(24));
        assert_eq!(value_i32(&attributes, "float"), Some(24), "rounded");
        assert_eq!(value_i32(&attributes, "tooLarge"), None, "must not wrap");
        assert_eq!(value_i32(&attributes, "tooSmall"), None, "must not wrap");
        assert_eq!(value_i32(&attributes, "text"), Some(24));
        assert_eq!(value_i32(&attributes, "padded"), Some(24));
        assert_eq!(value_i32(&attributes, "nothing"), None);
        assert_eq!(value_i32(&attributes, "junk"), None);
        assert_eq!(value_i32(&attributes, "absent"), None);
    }

    #[test]
    fn a_string_falls_back_to_rendering_a_number() {
        // A map or mod whose name is all digits arrives unquoted from some
        // endpoints; returning "" for it would blank the row.
        let attributes = serde_json::json!({ "text": "Seton's", "number": 1234, "float": 12.5 });
        assert_eq!(value_string(&attributes, "text"), "Seton's");
        assert_eq!(value_string(&attributes, "number"), "1234");
        assert_eq!(value_string(&attributes, "float"), "12.5");
        assert_eq!(value_string(&attributes, "absent"), "");
    }

    #[test]
    fn a_boolean_accepts_the_zero_one_form() {
        let attributes = serde_json::json!({ "yes": true, "one": 1, "zero": 0 });
        assert!(value_bool(&attributes, "yes"));
        assert!(value_bool(&attributes, "one"));
        assert!(!value_bool(&attributes, "zero"));
        assert!(!value_bool(&attributes, "absent"));
    }

    #[test]
    fn read_failures_keep_the_recovery_category() {
        use faf_domain::state::RequestFailureKind;
        use reqwest::StatusCode;

        let cases = [
            (StatusCode::UNAUTHORIZED, RequestFailureKind::Unauthorized),
            (StatusCode::NOT_FOUND, RequestFailureKind::NotFound),
            (StatusCode::FORBIDDEN, RequestFailureKind::Rejected),
            (StatusCode::SERVICE_UNAVAILABLE, RequestFailureKind::Offline),
            (StatusCode::FOUND, RequestFailureKind::Unexpected),
        ];

        for (status, expected) in cases {
            let error = response_error(status, "/data/coopMission", "not JSON");
            assert_eq!(error.kind(), expected, "status {status}");
        }
    }

    #[test]
    fn a_rejection_preserves_the_json_api_explanation() {
        let error = response_error(
            reqwest::StatusCode::UNPROCESSABLE_ENTITY,
            "/data/coopMission",
            r#"{"errors":[{"detail":"That filter is not allowed."}]}"#,
        );
        assert_eq!(error.message(), "That filter is not allowed.");
    }

    #[test]
    fn server_errors_do_not_echo_an_untrusted_response_body() {
        let error = response_error(
            reqwest::StatusCode::BAD_GATEWAY,
            "/data/coopMission",
            "proxy dump containing internal details",
        );
        assert!(!error.message().contains("internal details"));
    }

    #[tokio::test]
    async fn oversized_documents_are_rejected_before_the_body_is_buffered() {
        use faf_domain::state::RequestFailureKind;
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await.expect("read request");
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.api+json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        MAX_DOCUMENT_BYTES + 1
                    )
                    .as_bytes(),
                )
                .await
                .expect("write response headers");
        });

        let error = fetch_document_typed(
            &reqwest::Client::new(),
            url::Url::parse(&format!("http://{address}/data/test")).expect("test URL"),
            "token",
        )
        .await
        .expect_err("oversized document must fail");

        assert_eq!(error.kind(), RequestFailureKind::Unexpected);
        assert!(error.message().contains("too large"));
        server.await.expect("test server task");
    }
}
