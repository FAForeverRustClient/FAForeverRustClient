//! Timestamp deltas for the lookup index, separate from live vault search.
use super::jsonapi::{
    fetch_all_pages_with_progress, rel_target, resource_index, value_bool, JsonApiDoc,
};
use crate::ports::catalogue::CatalogueBatch;

/// How far before the saved change time a delta starts reading. The newest
/// time is the largest one seen anywhere in a read, so a record that changed
/// earlier, on a page already fetched, or that was written before a slow
/// commit, sorts below it and was skipped until the weekly crawl. Reading the
/// last hour again is harmless: merging is by id.
const DELTA_OVERLAP: chrono::Duration = chrono::Duration::hours(1);

/// faf-java-api's Map and Mod and their version entities all carry
/// createTime and updateTime; latestVersion is a formula, so a version upload
/// need not touch its parent's timestamp, hence the four fields. Inclusive
/// bounds replay timestamp ties safely; do not add the visible-only filter or
/// withdrawals disappear. See docs/vault-catalogue-cache.md.
pub(crate) fn delta_filter(since: &str) -> Result<String, String> {
    let since = (chrono::DateTime::parse_from_rfc3339(since)
        .map_err(|_| "invalid catalogue change timestamp".to_string())?
        - DELTA_OVERLAP)
        .to_rfc3339();
    Ok([
        "updateTime",
        "createTime",
        "latestVersion.updateTime",
        "latestVersion.createTime",
    ]
    .map(|field| format!("{field}=ge='{since}'"))
    .join(","))
}

pub(crate) async fn delta(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    resource: &str,
    include: &str,
    since: &str,
) -> Result<Vec<JsonApiDoc>, String> {
    let filter = delta_filter(since)?;
    let docs = fetch_all_pages_with_progress(
        http,
        token,
        200,
        100,
        |_, _| {},
        |page| {
            let mut url = url::Url::parse(&format!("{api_base}/data/{resource}"))
                .map_err(|_| "invalid API base".to_string())?;
            url.query_pairs_mut()
                .append_pair("filter", &filter)
                .append_pair("sort", "-updateTime,-id")
                .append_pair("page[size]", "100")
                .append_pair("page[number]", &page.to_string())
                .append_pair("include", include);
            Ok(url)
        },
    )
    .await?;
    complete(&docs)?;
    Ok(docs)
}

pub(crate) fn complete(docs: &[JsonApiDoc]) -> Result<(), String> {
    let reported = docs
        .first()
        .and_then(|doc| super::jsonapi::meta_page_i32(&doc.meta, "totalPages"));
    if reported.is_some_and(|pages| pages as usize > docs.len())
        || (reported.is_none()
            && docs.len() >= 200
            && docs.last().is_some_and(|doc| doc.data.len() >= 100))
    {
        return Err("catalogue exceeds the supported page limit".into());
    }
    Ok(())
}

/// `strict` for a delta, whose change time must not move past a record it
/// could not read, or that record would never be read again. A full crawl is
/// not strict: one malformed record among thousands failed the whole crawl,
/// on every start of a client with no saved copy; it is skipped and logged.
pub(crate) fn batch<T>(
    docs: &[JsonApiDoc],
    entries: Vec<T>,
    previous: &str,
    strict: bool,
) -> Result<CatalogueBatch<T>, String> {
    let mut newest = chrono::DateTime::parse_from_rfc3339(previous).ok();
    let mut removed_ids = Vec::new();
    let mut records = 0;
    for doc in docs {
        let index = resource_index(&doc.included);
        for parent in &doc.data {
            records += 1;
            let version = rel_target(&parent.relationships, "latestVersion")
                .and_then(|rel| index.get(&rel).copied());
            for resource in std::iter::once(parent).chain(version) {
                let mut has_timestamp = false;
                for field in ["updateTime", "createTime"] {
                    if let Some(date) = resource
                        .attributes
                        .get(field)
                        .and_then(serde_json::Value::as_str)
                        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                    {
                        has_timestamp = true;
                        if newest.is_none_or(|known| date > known) {
                            newest = Some(date);
                        }
                    }
                }
                if !has_timestamp {
                    if strict {
                        return Err("catalogue record has no change timestamps".into());
                    }
                    tracing::warn!(id = %parent.id, "catalogue record has no change timestamps; skipped");
                }
            }
            if version.is_some_and(|version| value_bool(&version.attributes, "hidden")) {
                removed_ids.push(
                    parent
                        .id
                        .parse::<i32>()
                        .map_err(|_| "invalid catalogue record id".to_string())?,
                );
            }
        }
    }
    // Never advance past a record that could not be decoded. Otherwise that
    // record might be missed forever by subsequent timestamp deltas.
    if records != entries.len() {
        if strict {
            return Err("catalogue response is missing latest-version data".into());
        }
        tracing::warn!(
            records,
            read = entries.len(),
            "catalogue records without latest-version data were skipped"
        );
    }
    if records > 0 && newest.is_none() {
        return Err("catalogue response has no change timestamps".into());
    }
    Ok(CatalogueBatch {
        entries,
        removed_ids,
        newest_change: newest
            .map(|date| date.to_rfc3339())
            .unwrap_or_else(|| "1970-01-01T00:00:00Z".into()),
        pages: docs.len() as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalogue_delta_filter_covers_parent_and_version_changes() {
        let query = delta_filter("2026-10-16T12:00:00Z").unwrap();
        for field in [
            "updateTime",
            "createTime",
            "latestVersion.updateTime",
            "latestVersion.createTime",
        ] {
            assert!(query.contains(&format!("{field}=ge=")));
        }
        assert!(!query.contains("hidden"));
        assert!(delta_filter("anything';hidden==true").is_err());
    }
    #[test]
    fn catalogue_watermark_uses_parent_and_version_but_not_related_profiles() {
        let doc: JsonApiDoc=serde_json::from_value(serde_json::json!({
            "data":[{"type":"map","id":"1","attributes":{"createTime":"2026-09-01T00:00:00Z","updateTime":"2026-10-01T00:00:00Z"},
                "relationships":{"latestVersion":{"data":{"type":"mapVersion","id":"12"}}}}],
            "included":[{"type":"mapVersion","id":"12","attributes":{"createTime":"2026-10-02T00:00:00Z","updateTime":"2026-10-03T00:00:00Z","hidden":true}},
                {"type":"player","id":"42","attributes":{"updateTime":"2026-10-15T00:00:00Z"}}]
        })).unwrap();
        let delta = batch(
            std::slice::from_ref(&doc),
            vec![1],
            "2026-10-01T12:00:00Z",
            true,
        )
        .unwrap();
        assert_eq!(delta.newest_change, "2026-10-03T00:00:00+00:00");
        assert_eq!(delta.removed_ids, vec![1]);
        assert!(batch::<i32>(std::slice::from_ref(&doc), vec![], "", true).is_err());
        let no_change =
            batch::<i32>(&[JsonApiDoc::default()], vec![], &delta.newest_change, true).unwrap();
        assert_eq!(no_change.newest_change, delta.newest_change);
        // Inclusive replay is idempotent and cannot move the cursor backwards.
        assert_eq!(
            batch(&[doc], vec![1], &delta.newest_change, true)
                .unwrap()
                .newest_change,
            delta.newest_change
        );
        let capped: JsonApiDoc = serde_json::from_value(
            serde_json::json!({"data":[],"meta":{"page":{"totalPages":201}}}),
        )
        .unwrap();
        assert!(complete(&[capped]).is_err());
    }
    #[tokio::test]
    async fn catalogue_delta_reads_every_matching_page_without_a_visibility_filter() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut pages = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut bytes = [0; 1024];
                    let count = stream.read(&mut bytes).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&bytes[..count]);
                    if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap();
                let path = request
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                let url = url::Url::parse(&format!("http://localhost{path}")).unwrap();
                let query: std::collections::HashMap<_, _> =
                    url.query_pairs().into_owned().collect();
                assert_eq!(url.path(), "/data/map");
                assert_eq!(
                    query["filter"],
                    delta_filter("2026-10-01T00:00:00Z").unwrap()
                );
                assert_eq!(query["include"], "latestVersion,author");
                assert_eq!(query["sort"], "-updateTime,-id");
                let page = query["page[number]"].parse::<i32>().unwrap();
                pages.push(page);
                let body=serde_json::json!({"data":[{"type":"map","id":page.to_string(),"attributes":{"updateTime":"2026-10-01T00:00:00Z"}}],"meta":{"page":{"totalPages":2}}}).to_string();
                let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/vnd.api+json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                stream.write_all(response.as_bytes()).await.unwrap();
            }
            pages
        });
        let docs = delta(
            &reqwest::Client::new(),
            "fixture-token",
            &api_base,
            "map",
            "latestVersion,author",
            "2026-10-01T00:00:00Z",
        )
        .await
        .unwrap();
        assert_eq!(docs.len(), 2);
        assert_eq!(server.await.unwrap(), vec![1, 2]);
    }
}
