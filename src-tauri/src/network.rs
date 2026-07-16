use crate::{error::ApiError, model::ConnectorKind};
use chrono::{DateTime, SecondsFormat, Utc};
use quick_xml::{
    events::{BytesDecl, BytesStart, Event},
    Reader, XmlVersion,
};
use reqwest::{
    dns::{Addrs, Name, Resolve, Resolving},
    header::{
        ACCEPT, CONTENT_TYPE, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, LOCATION,
    },
    redirect::Policy,
    Client, StatusCode,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    error::Error,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use url::Url;

pub const MAX_HTTP_URL_LENGTH: usize = 4_096;
pub const MAX_RESPONSE_BYTES: usize = 12_000_000;
pub const MAX_AGGREGATE_RESPONSE_BYTES: usize = 24_000_000;
const MAX_REDIRECTS: usize = 5;
const MAX_XML_NODES: usize = 50_000;
const MAX_XML_ATTRIBUTES: usize = 30_000;
// quick-xml exposes Text and GeneralRef as events without counting them as
// structural nodes. Bound the complete stream as well so a small document
// cannot monopolize one of the two parser workers with millions of entities.
const MAX_XML_EVENTS: usize = 200_000;
const MAX_XML_DEPTH: usize = 64;
const MAX_XML_DECLARATION_BYTES: usize = 256;
const MAX_ITEMS_PER_SOURCE: usize = 2_000;
const MAX_FIELD_BYTES: usize = 16 * 1024;
const MAX_HTML_DISCOVERY_BYTES: usize = 256 * 1024;
const MAX_HTML_DISCOVERY_NODES: usize = 4_000;
const MAX_HTML_DISCOVERY_ATTRIBUTES: usize = 12_000;
const MAX_DISCOVERED_FEEDS: usize = 4;
const MAX_GLOBAL_REQUESTS: usize = 6;
const MAX_REQUESTS_PER_ORIGIN: usize = 2;
const MAX_PARSER_TASKS: usize = 2;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(15);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedProbeRequest {
    pub url: String,
    pub connector_kind: Option<ConnectorKind>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeedProbeResponse {
    pub final_url: String,
    pub connector_kind: ConnectorKind,
    pub title: Option<String>,
    pub item_count: u16,
    pub samples: Vec<FeedProbeSample>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeedProbeSample {
    pub title: String,
    pub published_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedFeed {
    pub kind: ConnectorKind,
    pub title: Option<String>,
    pub items: Vec<ParsedFeedItem>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedFeedItem {
    pub canonical_url: String,
    pub title: String,
    pub summary: Option<String>,
    pub image_url: Option<String>,
    pub published_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FeedValidators {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FeedRefreshOutcome {
    NotModified {
        final_url: String,
        validators: FeedValidators,
    },
    Modified {
        final_url: String,
        content_type: Option<String>,
        validators: FeedValidators,
        body: Vec<u8>,
        parsed: ParsedFeed,
    },
}

struct FetchedDocument {
    final_url: Url,
    content_type: Option<String>,
    validators: FeedValidators,
    bytes: Vec<u8>,
    _body_budget: OwnedSemaphorePermit,
}

enum FetchedDocumentOutcome {
    NotModified {
        final_url: Url,
        validators: FeedValidators,
    },
    Modified(FetchedDocument),
}

enum FetchResponse {
    NotModified {
        final_url: Url,
        validators: FeedValidators,
    },
    Modified {
        final_url: Url,
        content_type: Option<String>,
        validators: FeedValidators,
        bytes: Vec<u8>,
        body_budget: OwnedSemaphorePermit,
    },
}

#[derive(Clone)]
pub struct FeedTransport {
    client: Client,
    request_slots: Arc<Semaphore>,
    origin_slots: OriginSlots,
    response_budget: Arc<Semaphore>,
    parser_slots: Arc<Semaphore>,
}

impl FeedTransport {
    pub fn new() -> Result<Self, ApiError> {
        let client = Client::builder()
            .redirect(Policy::none())
            // Platform proxy resolution is intentionally not approximated.
            // Direct requests may fail on a proxy-only network, but custom
            // sources can never escape the SSRF resolver through a proxy.
            .no_proxy()
            .dns_resolver(PublicDnsResolver)
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .referer(false)
            .user_agent(concat!("VibeDeck/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| ApiError::network("Le transport local n'a pas pu démarrer."))?;
        Ok(Self {
            client,
            request_slots: Arc::new(Semaphore::new(MAX_GLOBAL_REQUESTS)),
            origin_slots: OriginSlots::default(),
            response_budget: Arc::new(Semaphore::new(MAX_AGGREGATE_RESPONSE_BYTES)),
            parser_slots: Arc::new(Semaphore::new(MAX_PARSER_TASKS)),
        })
    }

    pub async fn probe(
        &self,
        request: FeedProbeRequest,
        cancellation: CancellationToken,
    ) -> Result<FeedProbeResponse, ApiError> {
        let start_url = normalize_feed_url(&request.url)?;
        let operation = self.fetch_and_parse(start_url, cancellation.clone());
        let timed = cancellation
            .run_until_cancelled(tokio::time::timeout(TOTAL_TIMEOUT, operation))
            .await
            .ok_or_else(ApiError::cancelled)?;
        let (final_url, parsed) =
            timed.map_err(|_| ApiError::network("La source met trop de temps à répondre."))??;
        if request
            .connector_kind
            .is_some_and(|expected| expected != parsed.kind)
        {
            return Err(ApiError::invalid(
                "Le type de connecteur reçu ne correspond pas au type demandé.",
            ));
        }
        Ok(FeedProbeResponse {
            final_url: final_url.to_string(),
            connector_kind: parsed.kind,
            title: parsed.title,
            item_count: u16::try_from(parsed.items.len())
                .map_err(|_| ApiError::internal("Cardinalité de flux invalide."))?,
            samples: parsed
                .items
                .into_iter()
                .take(3)
                .map(|item| FeedProbeSample {
                    title: item.title,
                    published_at: item.published_at,
                })
                .collect(),
        })
    }

    /// Conditional refresh path used only after a source has been committed.
    /// `NotModified` carries no body and performs no parser work; the caller
    /// may skip the authoritative upsert only when its cache entry is marked
    /// as already materialized.
    pub async fn refresh(
        &self,
        url: &str,
        validators: FeedValidators,
        cancellation: CancellationToken,
    ) -> Result<FeedRefreshOutcome, ApiError> {
        let start_url = normalize_feed_url(url)?;
        validate_feed_validators(&validators)?;
        let operation =
            self.fetch_document_with_validators(start_url, Some(&validators), &cancellation);
        let fetched = cancellation
            .run_until_cancelled(tokio::time::timeout(TOTAL_TIMEOUT, operation))
            .await
            .ok_or_else(ApiError::cancelled)?
            .map_err(|_| ApiError::network("La source met trop de temps à répondre."))??;
        match fetched {
            FetchedDocumentOutcome::NotModified {
                final_url,
                validators,
            } => Ok(FeedRefreshOutcome::NotModified {
                final_url: final_url.to_string(),
                validators,
            }),
            FetchedDocumentOutcome::Modified(document) => {
                let final_url = document.final_url.to_string();
                let content_type = document.content_type.clone();
                let validators = document.validators.clone();
                let (parsed, body) = self
                    .parse_fetched_document_retaining_body(document, cancellation)
                    .await?;
                Ok(FeedRefreshOutcome::Modified {
                    final_url,
                    content_type,
                    validators,
                    body,
                    parsed,
                })
            }
        }
    }

    /// Parses a previously validated disposable-cache body without performing
    /// network I/O. This path is required when a conditional request returns
    /// 304 for an entry that was written before its authoritative SQLite
    /// ingestion committed.
    pub(crate) async fn parse_cached(
        &self,
        body: Vec<u8>,
        final_url: &str,
        cancellation: CancellationToken,
    ) -> Result<ParsedFeed, ApiError> {
        if body.is_empty() || body.len() > MAX_RESPONSE_BYTES {
            return Err(ApiError::invalid("Réponse HTTP hors budget."));
        }
        let final_url = normalize_feed_url(final_url)?;
        let body_budget = acquire_many(
            &self.response_budget,
            u32::try_from(body.len())
                .map_err(|_| ApiError::invalid("Réponse HTTP hors budget."))?,
            &cancellation,
        )
        .await?;
        let _parser_slot = acquire_one(&self.parser_slots, &cancellation).await?;
        let parser_cancellation = cancellation.clone();
        let parse = tauri::async_runtime::spawn_blocking(move || {
            let _body_budget = body_budget;
            parse_feed_document_with_cancel(&body, &final_url, &parser_cancellation)
        });
        cancellation
            .run_until_cancelled(parse)
            .await
            .ok_or_else(ApiError::cancelled)?
            .map_err(|_| ApiError::internal("Le parseur de flux s'est arrêté."))?
    }

    async fn fetch_and_parse(
        &self,
        start_url: Url,
        cancellation: CancellationToken,
    ) -> Result<(Url, ParsedFeed), ApiError> {
        let document = self.fetch_document(start_url, &cancellation).await?;
        if response_looks_like_html(&document.bytes) {
            let page_url = document.final_url.clone();
            let parser_cancellation = cancellation.clone();
            let discover = tauri::async_runtime::spawn_blocking(move || {
                let _body_budget = document._body_budget;
                discover_feed_urls(&document.bytes, &page_url, &parser_cancellation)
            });
            let candidates = cancellation
                .run_until_cancelled(discover)
                .await
                .ok_or_else(ApiError::cancelled)?
                .map_err(|_| ApiError::internal("La découverte de flux s'est arrêtée."))??;
            if candidates.is_empty() {
                return Err(ApiError::invalid(
                    "Ce site ne déclare aucun flux RSS ou Atom.",
                ));
            }

            // HTML discovery declares at most four candidates. Race them so a
            // slow or dead alternate cannot delay a healthy feed; the network
            // semaphores still enforce six global and two per origin.
            let mut attempts = tokio::task::JoinSet::new();
            for candidate in candidates {
                let transport = self.clone();
                let attempt_cancellation = cancellation.child_token();
                attempts.spawn(async move {
                    transport
                        .fetch_direct_feed(candidate, attempt_cancellation)
                        .await
                });
            }
            let mut last_error = None;
            while !attempts.is_empty() {
                let Some(joined) = cancellation.run_until_cancelled(attempts.join_next()).await
                else {
                    attempts.abort_all();
                    return Err(ApiError::cancelled());
                };
                match joined {
                    Some(Ok(Ok(feed))) => {
                        attempts.abort_all();
                        return Ok(feed);
                    }
                    Some(Ok(Err(error))) => last_error = Some(error),
                    Some(Err(_)) => {
                        last_error = Some(ApiError::internal(
                            "Une tentative de découverte de flux s'est arrêtée.",
                        ));
                    }
                    None => break,
                }
            }
            return Err(last_error.unwrap_or_else(|| {
                ApiError::invalid("Aucun flux RSS ou Atom déclaré n'est exploitable.")
            }));
        }
        self.parse_fetched_document(document, cancellation).await
    }

    async fn fetch_direct_feed(
        &self,
        start_url: Url,
        cancellation: CancellationToken,
    ) -> Result<(Url, ParsedFeed), ApiError> {
        let document = self.fetch_document(start_url, &cancellation).await?;
        self.parse_fetched_document(document, cancellation).await
    }

    async fn fetch_document(
        &self,
        start_url: Url,
        cancellation: &CancellationToken,
    ) -> Result<FetchedDocument, ApiError> {
        match self
            .fetch_document_with_validators(start_url, None, cancellation)
            .await?
        {
            FetchedDocumentOutcome::Modified(document) => Ok(document),
            FetchedDocumentOutcome::NotModified { .. } => Err(ApiError::network(
                "La source a renvoyé un statut conditionnel inattendu.",
            )),
        }
    }

    async fn fetch_document_with_validators(
        &self,
        start_url: Url,
        validators: Option<&FeedValidators>,
        cancellation: &CancellationToken,
    ) -> Result<FetchedDocumentOutcome, ApiError> {
        match self
            .fetch_following_safe_redirects(start_url, validators, cancellation)
            .await?
        {
            FetchResponse::NotModified {
                final_url,
                validators,
            } => Ok(FetchedDocumentOutcome::NotModified {
                final_url,
                validators,
            }),
            FetchResponse::Modified {
                final_url,
                content_type,
                validators,
                bytes,
                body_budget,
            } => Ok(FetchedDocumentOutcome::Modified(FetchedDocument {
                final_url,
                content_type,
                validators,
                bytes,
                _body_budget: body_budget,
            })),
        }
    }

    async fn parse_fetched_document(
        &self,
        document: FetchedDocument,
        cancellation: CancellationToken,
    ) -> Result<(Url, ParsedFeed), ApiError> {
        let final_url = document.final_url.clone();
        let (parsed, _) = self
            .parse_fetched_document_retaining_body(document, cancellation)
            .await?;
        Ok((final_url, parsed))
    }

    async fn parse_fetched_document_retaining_body(
        &self,
        document: FetchedDocument,
        cancellation: CancellationToken,
    ) -> Result<(ParsedFeed, Vec<u8>), ApiError> {
        let FetchedDocument {
            final_url,
            content_type: _,
            validators: _,
            bytes,
            _body_budget: body_budget,
        } = document;
        let _parser_slot = acquire_one(&self.parser_slots, &cancellation).await?;
        let base_url = final_url.clone();
        let parser_cancellation = cancellation.clone();
        let parse = tauri::async_runtime::spawn_blocking(move || {
            let _body_budget = body_budget;
            let parsed = parse_feed_document_with_cancel(&bytes, &base_url, &parser_cancellation)?;
            Ok::<_, ApiError>((parsed, bytes))
        });
        cancellation
            .run_until_cancelled(parse)
            .await
            .ok_or_else(ApiError::cancelled)?
            .map_err(|_| ApiError::internal("Le parseur de flux s'est arrêté."))?
    }

    async fn fetch_following_safe_redirects(
        &self,
        start_url: Url,
        validators: Option<&FeedValidators>,
        cancellation: &CancellationToken,
    ) -> Result<FetchResponse, ApiError> {
        let mut current = start_url.clone();
        for redirect_count in 0..=MAX_REDIRECTS {
            if cancellation.is_cancelled() {
                return Err(ApiError::cancelled());
            }
            // Queue on the publisher before taking a global slot. A noisy
            // origin can therefore never starve unrelated publications.
            let origin_semaphore = self.origin_slots.semaphore_for(&current)?;
            let _origin_slot = acquire_one(&origin_semaphore, cancellation).await?;
            let _request_slot = acquire_one(&self.request_slots, cancellation).await?;
            let mut request = self
                .client
                .get(current.clone())
                .header(
                    ACCEPT,
                    "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
                );
            if let Some(etag) = validators.and_then(|value| value.etag.as_deref()) {
                request = request.header(IF_NONE_MATCH, etag);
            }
            if let Some(last_modified) = validators.and_then(|value| value.last_modified.as_deref())
            {
                request = request.header(IF_MODIFIED_SINCE, last_modified);
            }
            let request = request.send();
            let mut response = cancellation
                .run_until_cancelled(request)
                .await
                .ok_or_else(ApiError::cancelled)?
                .map_err(|_| {
                    ApiError::network("Cette source ne peut pas être contactée de manière sûre.")
                })?;
            let status = response.status();
            if is_redirect(status) {
                if redirect_count == MAX_REDIRECTS {
                    return Err(ApiError::network(
                        "Cette source effectue trop de redirections.",
                    ));
                }
                let location = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| ApiError::network("La redirection est incomplète."))?;
                let redirected = current
                    .join(location)
                    .map_err(|_| ApiError::network("La redirection est invalide."))?;
                let redirected = normalize_feed_url(redirected.as_str())?;
                if !urls_share_host_tree(&start_url, &redirected) {
                    return Err(ApiError::unsafe_network(
                        "La source redirige vers un autre domaine.",
                    ));
                }
                current = redirected;
                continue;
            }
            if status == StatusCode::NOT_MODIFIED {
                let cached = validators.ok_or_else(|| {
                    ApiError::network("La source a renvoyé un statut conditionnel inattendu.")
                })?;
                return Ok(FetchResponse::NotModified {
                    final_url: current,
                    validators: response_validators(response.headers(), cached),
                });
            }
            if !status.is_success() {
                return Err(ApiError::network(format!(
                    "La source répond avec le statut {}.",
                    status.as_u16()
                )));
            }
            if response
                .content_length()
                .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
            {
                return Err(ApiError::invalid(
                    "Ce flux est trop volumineux pour être ajouté.",
                ));
            }
            // Open connections and validate response headers under the six
            // request slots first. Only then reserve a complete maximum body:
            // this lets six refreshes make network progress while still
            // guaranteeing that at most two 12 MiB bodies await parsing and
            // avoids partial-body semaphore deadlocks.
            let body_budget = acquire_many(
                &self.response_budget,
                u32::try_from(MAX_RESPONSE_BYTES).expect("response budget fits u32"),
                cancellation,
            )
            .await?;
            let mut body = Vec::with_capacity(
                response
                    .content_length()
                    .unwrap_or(0)
                    .min(MAX_RESPONSE_BYTES as u64) as usize,
            );
            loop {
                let chunk = cancellation
                    .run_until_cancelled(response.chunk())
                    .await
                    .ok_or_else(ApiError::cancelled)?
                    .map_err(|_| ApiError::network("La réponse de cette source est incomplète."))?;
                let Some(chunk) = chunk else { break };
                if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                    return Err(ApiError::invalid(
                        "Ce flux est trop volumineux pour être ajouté.",
                    ));
                }
                body.extend_from_slice(&chunk);
            }
            return Ok(FetchResponse::Modified {
                final_url: current,
                content_type: bounded_header(response.headers(), &CONTENT_TYPE, 256),
                validators: response_validators(response.headers(), &FeedValidators::default()),
                bytes: body,
                body_budget,
            });
        }
        Err(ApiError::network(
            "Cette source effectue trop de redirections.",
        ))
    }
}

/// Registry of per-origin concurrency limits. Entries only keep weak
/// references, so probing arbitrary URLs cannot make the map grow forever.
#[derive(Clone, Default)]
struct OriginSlots {
    entries: Arc<Mutex<HashMap<String, Weak<Semaphore>>>>,
}

impl OriginSlots {
    fn semaphore_for(&self, url: &Url) -> Result<Arc<Semaphore>, ApiError> {
        let origin = url.origin().ascii_serialization();
        if origin == "null" {
            return Err(ApiError::invalid("Origine de source invalide."));
        }
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| ApiError::internal("Le limiteur réseau local est indisponible."))?;
        entries.retain(|_, semaphore| semaphore.strong_count() > 0);
        if let Some(semaphore) = entries.get(&origin).and_then(Weak::upgrade) {
            return Ok(semaphore);
        }
        let semaphore = Arc::new(Semaphore::new(MAX_REQUESTS_PER_ORIGIN));
        entries.insert(origin, Arc::downgrade(&semaphore));
        Ok(semaphore)
    }
}

async fn acquire_one(
    semaphore: &Arc<Semaphore>,
    cancellation: &CancellationToken,
) -> Result<OwnedSemaphorePermit, ApiError> {
    cancellation
        .run_until_cancelled(semaphore.clone().acquire_owned())
        .await
        .ok_or_else(ApiError::cancelled)?
        .map_err(|_| ApiError::internal("Le service réseau local s'est arrêté."))
}

async fn acquire_many(
    semaphore: &Arc<Semaphore>,
    permits: u32,
    cancellation: &CancellationToken,
) -> Result<OwnedSemaphorePermit, ApiError> {
    cancellation
        .run_until_cancelled(semaphore.clone().acquire_many_owned(permits))
        .await
        .ok_or_else(ApiError::cancelled)?
        .map_err(|_| ApiError::internal("Le budget de réponse local s'est arrêté."))
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

fn validate_feed_validators(validators: &FeedValidators) -> Result<(), ApiError> {
    for value in [
        validators.etag.as_deref(),
        validators.last_modified.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if value.is_empty()
            || value.len() > 1_024
            || reqwest::header::HeaderValue::from_str(value).is_err()
        {
            return Err(ApiError::invalid("Validateur de cache HTTP invalide."));
        }
    }
    Ok(())
}

fn bounded_header(
    headers: &reqwest::header::HeaderMap,
    name: &reqwest::header::HeaderName,
    limit: usize,
) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= limit)
        .map(str::to_owned)
}

fn response_validators(
    headers: &reqwest::header::HeaderMap,
    fallback: &FeedValidators,
) -> FeedValidators {
    FeedValidators {
        etag: bounded_header(headers, &ETAG, 1_024).or_else(|| fallback.etag.clone()),
        last_modified: bounded_header(headers, &LAST_MODIFIED, 1_024)
            .or_else(|| fallback.last_modified.clone()),
    }
}

pub fn normalize_feed_url(input: &str) -> Result<Url, ApiError> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_HTTP_URL_LENGTH {
        return Err(ApiError::invalid("URL de source invalide."));
    }
    let mut url = Url::parse(trimmed).map_err(|_| ApiError::invalid("URL de source invalide."))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(ApiError::invalid(
            "Seules les URLs HTTP et HTTPS sont acceptées.",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ApiError::invalid(
            "Les URLs contenant des identifiants sont refusées.",
        ));
    }
    if is_private_network_hostname(url.host_str().expect("host checked")) {
        return Err(ApiError::unsafe_network(
            "Les adresses locales, privées ou réservées sont bloquées.",
        ));
    }
    url.set_fragment(None);
    if url.as_str().len() > MAX_HTTP_URL_LENGTH {
        return Err(ApiError::invalid("URL de source trop longue."));
    }
    Ok(url)
}

fn urls_share_host_tree(first: &Url, second: &Url) -> bool {
    let normalize = |url: &Url| {
        url.host_str()
            .unwrap_or_default()
            .trim_end_matches('.')
            .trim_start_matches("www.")
            .trim_start_matches("m.")
            .to_ascii_lowercase()
    };
    let first = normalize(first);
    let second = normalize(second);
    first == second
        || first.ends_with(&format!(".{second}"))
        || second.ends_with(&format!(".{first}"))
}

fn response_looks_like_html(bytes: &[u8]) -> bool {
    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(4_096)]).to_ascii_lowercase();
    let html_position = prefix
        .find("<!doctype html")
        .into_iter()
        .chain(
            ["html", "head", "body"]
                .into_iter()
                .filter_map(|tag| first_html_tag_position(&prefix, tag)),
        )
        .min();
    let feed_position = ["rss", "rdf", "feed", "urlset"]
        .into_iter()
        .filter_map(|tag| first_html_tag_position(&prefix, tag))
        .min();
    html_position.is_some_and(|html| feed_position.is_none_or(|feed| html < feed))
}

fn first_html_tag_position(value: &str, tag: &str) -> Option<usize> {
    let needle = format!("<{tag}");
    value.match_indices(&needle).find_map(|(position, _)| {
        html_tag_boundary(value.as_bytes().get(position + needle.len()).copied())
            .then_some(position)
    })
}

fn discover_feed_urls(
    bytes: &[u8],
    page_url: &Url,
    cancellation: &CancellationToken,
) -> Result<Vec<Url>, ApiError> {
    let prefix_length = bytes.len().min(MAX_HTML_DISCOVERY_BYTES.saturating_add(4));
    let html = String::from_utf8_lossy(&bytes[..prefix_length]);
    let fragment = bounded_html_head(&html, bytes.len() > prefix_length)?;
    let lower = fragment.to_ascii_lowercase();
    let mut cursor = 0usize;
    let mut nodes = 0usize;
    let mut attributes = 0usize;
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    while cursor < fragment.len() && candidates.len() < MAX_DISCOVERED_FEEDS {
        if nodes.is_multiple_of(128) && cancellation.is_cancelled() {
            return Err(ApiError::cancelled());
        }
        let Some(relative_start) = fragment[cursor..].find('<') else {
            break;
        };
        let tag_start = cursor + relative_start;
        if fragment[tag_start..].starts_with("<!--") {
            cursor = fragment[tag_start + 4..]
                .find("-->")
                .map_or(fragment.len(), |offset| tag_start + 4 + offset + 3);
            continue;
        }
        let Some(tag_end) = find_html_tag_end(fragment, tag_start) else {
            break;
        };
        let marker = fragment.as_bytes().get(tag_start + 1).copied();
        if matches!(marker, Some(b'/') | Some(b'!') | Some(b'?')) {
            cursor = tag_end + 1;
            continue;
        }

        let name_start = tag_start + 1;
        let mut name_end = name_start;
        while name_end < tag_end
            && !fragment.as_bytes()[name_end].is_ascii_whitespace()
            && !matches!(fragment.as_bytes()[name_end], b'/' | b'>')
        {
            name_end += 1;
        }
        let tag_name = &lower[name_start..name_end];
        if tag_name.is_empty() {
            cursor = tag_end + 1;
            continue;
        }
        nodes += 1;
        if nodes > MAX_HTML_DISCOVERY_NODES {
            return Err(ApiError::invalid(
                "Cette page contient trop d'éléments HTML pour rechercher un flux.",
            ));
        }
        let values = scan_discovery_attributes(fragment, name_end, tag_end, &mut attributes)?;

        if tag_name == "link" {
            let alternate = values
                .get("rel")
                .is_some_and(|rel| rel.split_ascii_whitespace().any(|part| part == "alternate"));
            let feed_type = values.get("type").is_some_and(|kind| {
                matches!(
                    kind.as_str(),
                    "application/rss+xml" | "application/atom+xml" | "application/xml" | "text/xml"
                )
            });
            if alternate && feed_type {
                if let Some(candidate) = values
                    .get("href")
                    .and_then(|href| resolve_discovered_feed_url(href, page_url))
                {
                    let candidate_string = candidate.to_string();
                    if urls_share_host_tree(page_url, &candidate) && seen.insert(candidate_string) {
                        candidates.push(candidate);
                    }
                }
            }
        }

        if matches!(tag_name, "script" | "style") {
            let needle = format!("</{tag_name}");
            if let Some(close_offset) = lower[tag_end + 1..].find(&needle) {
                let close_start = tag_end + 1 + close_offset;
                cursor =
                    find_html_tag_end(fragment, close_start).map_or(fragment.len(), |end| end + 1);
                continue;
            }
        }
        cursor = tag_end + 1;
    }
    Ok(candidates)
}

fn bounded_html_head(html: &str, was_truncated: bool) -> Result<&str, ApiError> {
    let lower = html.to_ascii_lowercase();
    let start = lower
        .find("<head")
        .filter(|index| html_tag_boundary(lower.as_bytes().get(index + 5).copied()))
        .unwrap_or(0);
    if let Some(relative_close) = lower[start..].find("</head") {
        let close_start = start + relative_close;
        if let Some(close_end) = find_html_tag_end(html, close_start) {
            if close_end + 1 - start <= MAX_HTML_DISCOVERY_BYTES {
                return Ok(&html[start..=close_end]);
            }
        }
    }
    if let Some(relative_body) = lower[start..].find("<body") {
        let body_start = start + relative_body;
        if html_tag_boundary(lower.as_bytes().get(body_start + 5).copied())
            && body_start - start <= MAX_HTML_DISCOVERY_BYTES
        {
            return Ok(&html[start..body_start]);
        }
    }
    if was_truncated || html.len().saturating_sub(start) > MAX_HTML_DISCOVERY_BYTES {
        return Err(ApiError::invalid(
            "L'en-tête HTML est trop volumineux pour rechercher un flux.",
        ));
    }
    Ok(&html[start..])
}

fn html_tag_boundary(value: Option<u8>) -> bool {
    value.is_none_or(|byte| byte.is_ascii_whitespace() || matches!(byte, b'>' | b'/'))
}

fn find_html_tag_end(html: &str, tag_start: usize) -> Option<usize> {
    let mut quote = None;
    for (offset, character) in html[tag_start + 1..].char_indices() {
        let cursor = tag_start + 1 + offset;
        if let Some(active_quote) = quote {
            if character == active_quote {
                quote = None;
            }
        } else if matches!(character, '\'' | '"') {
            quote = Some(character);
        } else if character == '>' {
            return Some(cursor);
        }
    }
    None
}

fn scan_discovery_attributes(
    html: &str,
    mut cursor: usize,
    tag_end: usize,
    total_attributes: &mut usize,
) -> Result<HashMap<String, String>, ApiError> {
    let mut selected = HashMap::new();
    while cursor < tag_end {
        while cursor < tag_end && html.as_bytes()[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= tag_end || html.as_bytes()[cursor] == b'/' {
            break;
        }
        let name_start = cursor;
        while cursor < tag_end
            && !html.as_bytes()[cursor].is_ascii_whitespace()
            && !matches!(html.as_bytes()[cursor], b'=' | b'/' | b'>')
        {
            cursor += 1;
        }
        if cursor == name_start {
            cursor += 1;
            continue;
        }
        *total_attributes += 1;
        if *total_attributes > MAX_HTML_DISCOVERY_ATTRIBUTES {
            return Err(ApiError::invalid(
                "Cette page contient trop d'attributs HTML pour rechercher un flux.",
            ));
        }
        let name = html[name_start..cursor].to_ascii_lowercase();
        while cursor < tag_end && html.as_bytes()[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= tag_end || html.as_bytes()[cursor] != b'=' {
            continue;
        }
        cursor += 1;
        while cursor < tag_end && html.as_bytes()[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let (value_start, value_end) =
            if cursor < tag_end && matches!(html.as_bytes()[cursor], b'\'' | b'"') {
                let quote = html.as_bytes()[cursor];
                cursor += 1;
                let start = cursor;
                while cursor < tag_end && html.as_bytes()[cursor] != quote {
                    cursor += 1;
                }
                let end = cursor;
                cursor = (cursor + 1).min(tag_end);
                (start, end)
            } else {
                let start = cursor;
                while cursor < tag_end && !html.as_bytes()[cursor].is_ascii_whitespace() {
                    cursor += 1;
                }
                (start, cursor)
            };
        if matches!(name.as_str(), "href" | "rel" | "type")
            && value_end.saturating_sub(value_start) <= MAX_HTTP_URL_LENGTH
        {
            let value = html[value_start..value_end]
                .replace("&amp;", "&")
                .replace("&#38;", "&");
            let value = if matches!(name.as_str(), "rel" | "type") {
                value.to_ascii_lowercase()
            } else {
                value
            };
            selected.entry(name).or_insert(value);
        }
    }
    Ok(selected)
}

fn resolve_discovered_feed_url(value: &str, page_url: &Url) -> Option<Url> {
    let resolved = page_url.join(value.trim()).ok()?;
    normalize_feed_url(resolved.as_str()).ok()
}

#[derive(Clone, Copy, Default)]
pub struct PublicDnsResolver;

impl Resolve for PublicDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let hostname = name.as_str().to_owned();
        Box::pin(async move {
            if is_private_network_hostname(&hostname) {
                return Err(resolve_error("private or reserved hostname"));
            }
            let resolved = tokio::net::lookup_host((hostname.as_str(), 0))
                .await
                .map_err(|_| resolve_error("DNS resolution failed"))?;
            let addresses = resolved.collect::<Vec<_>>();
            validated_public_addresses(addresses)
        })
    }
}

fn validated_public_addresses(
    addresses: Vec<SocketAddr>,
) -> Result<Addrs, Box<dyn Error + Send + Sync>> {
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(resolve_error("DNS returned a private or reserved address"));
    }
    let mut seen = HashSet::new();
    let public = addresses
        .into_iter()
        .filter(|address| seen.insert(*address))
        .collect::<Vec<_>>();
    Ok(Box::new(public.into_iter()))
}

fn resolve_error(message: &'static str) -> Box<dyn Error + Send + Sync> {
    Box::new(io::Error::new(io::ErrorKind::PermissionDenied, message))
}

pub fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => address
            .to_ipv4_mapped()
            .map(is_public_ipv4)
            .unwrap_or_else(|| is_public_ipv6(address)),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let value = u32::from(address);
    ![
        ("0.0.0.0", 8),
        ("10.0.0.0", 8),
        ("100.64.0.0", 10),
        ("127.0.0.0", 8),
        ("169.254.0.0", 16),
        ("172.16.0.0", 12),
        ("192.0.0.0", 24),
        ("192.0.2.0", 24),
        ("192.88.99.0", 24),
        ("192.168.0.0", 16),
        ("198.18.0.0", 15),
        ("198.51.100.0", 24),
        ("203.0.113.0", 24),
        ("224.0.0.0", 4),
        ("240.0.0.0", 4),
    ]
    .into_iter()
    .any(|(network, prefix)| ipv4_in_prefix(value, network, prefix))
}

fn ipv4_in_prefix(value: u32, network: &str, prefix: u32) -> bool {
    let network = u32::from(network.parse::<Ipv4Addr>().expect("constant IPv4 network"));
    let mask = u32::MAX.checked_shl(32 - prefix).unwrap_or(0);
    value & mask == network & mask
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    let value = u128::from(address);
    ipv6_in_prefix(value, "2000::", 3)
        && ![
            ("2001::", 23),
            ("2001:db8::", 32),
            ("2002::", 16),
            ("3fff::", 20),
        ]
        .into_iter()
        .any(|(network, prefix)| ipv6_in_prefix(value, network, prefix))
}

fn ipv6_in_prefix(value: u128, network: &str, prefix: u32) -> bool {
    let network = u128::from(network.parse::<Ipv6Addr>().expect("constant IPv6 network"));
    let mask = u128::MAX.checked_shl(128 - prefix).unwrap_or(0);
    value & mask == network & mask
}

fn is_private_network_hostname(hostname: &str) -> bool {
    let hostname = hostname
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    hostname == "localhost"
        || hostname.ends_with(".localhost")
        || hostname.ends_with(".local")
        || hostname.ends_with(".internal")
        || hostname.ends_with(".home.arpa")
        || hostname
            .parse::<IpAddr>()
            .is_ok_and(|address| !is_public_ip(address))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Capture {
    FeedTitle,
    Title,
    Summary,
    Link,
    Identifier,
    Published,
    Updated,
    LastModified,
    Image,
    PublicationName,
}

#[derive(Debug)]
struct Frame {
    local_name: String,
    capture: Option<Capture>,
    text: String,
}

#[derive(Default)]
struct EntryBuilder {
    title: Option<String>,
    summary: Option<String>,
    text_link: Option<String>,
    identifier: Option<String>,
    atom_links: Vec<(Option<String>, String)>,
    image: Option<String>,
    published: Option<String>,
    updated: Option<String>,
    last_modified: Option<String>,
    publication_name: Option<String>,
}

struct ParseState {
    kind: Option<ConnectorKind>,
    feed_title: Option<String>,
    frames: Vec<Frame>,
    current: Option<EntryBuilder>,
    items: Vec<ParsedFeedItem>,
    nodes: usize,
    attributes: usize,
    entry_count: usize,
    declaration_seen: bool,
    structural_seen: bool,
    xml_version: XmlVersion,
    root_seen: bool,
    root_closed: bool,
}

impl ParseState {
    fn new() -> Self {
        Self {
            kind: None,
            feed_title: None,
            frames: Vec::new(),
            current: None,
            items: Vec::new(),
            nodes: 0,
            attributes: 0,
            entry_count: 0,
            declaration_seen: false,
            structural_seen: false,
            xml_version: XmlVersion::Implicit1_0,
            root_seen: false,
            root_closed: false,
        }
    }

    fn consume_node(&mut self) -> Result<(), ApiError> {
        self.nodes += 1;
        if self.nodes > MAX_XML_NODES {
            return Err(ApiError::invalid("Le flux contient trop de nœuds XML."));
        }
        Ok(())
    }

    fn begin_element(&mut self, local_name: &str) -> Result<(), ApiError> {
        if self.frames.is_empty() {
            if self.root_seen || self.root_closed {
                return Err(ApiError::invalid(
                    "Le document XML doit contenir une seule racine.",
                ));
            }
            self.root_seen = true;
            self.kind = match local_name {
                "rss" | "rdf" => Some(ConnectorKind::Rss),
                "feed" => Some(ConnectorKind::Atom),
                "urlset" => Some(ConnectorKind::NewsSitemap),
                _ => None,
            };
        }
        let is_entry = matches!(
            (self.kind, local_name),
            (Some(ConnectorKind::Rss), "item")
                | (Some(ConnectorKind::Atom), "entry")
                | (Some(ConnectorKind::NewsSitemap), "url")
        );
        if is_entry {
            if self.current.is_some() {
                return Err(ApiError::invalid(
                    "Le flux contient des entrées imbriquées.",
                ));
            }
            self.entry_count += 1;
            if self.entry_count > MAX_ITEMS_PER_SOURCE {
                return Err(ApiError::invalid("Le flux contient plus de 2 000 entrées."));
            }
            self.current = Some(EntryBuilder::default());
        }
        Ok(())
    }

    fn capture_for(&self, local_name: &str) -> Option<Capture> {
        if self.current.is_none() {
            let feed_title = local_name == "title"
                && self
                    .frames
                    .iter()
                    .any(|frame| matches!(frame.local_name.as_str(), "channel" | "feed" | "rdf"));
            return feed_title.then_some(Capture::FeedTitle);
        }
        match local_name {
            "title" => Some(Capture::Title),
            "description" | "summary" | "content" | "encoded" => Some(Capture::Summary),
            "link" => Some(Capture::Link),
            "guid" | "id" => Some(Capture::Identifier),
            "pubdate" | "date" | "published" | "publication_date" => Some(Capture::Published),
            "updated" => Some(Capture::Updated),
            "lastmod" => Some(Capture::LastModified),
            "loc" => {
                if self.frames.iter().any(|frame| frame.local_name == "image") {
                    Some(Capture::Image)
                } else {
                    Some(Capture::Link)
                }
            }
            "name"
                if self
                    .frames
                    .iter()
                    .any(|frame| frame.local_name == "publication") =>
            {
                Some(Capture::PublicationName)
            }
            _ => None,
        }
    }

    fn finish_capture(&mut self, capture: Capture, text: String) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        if capture == Capture::FeedTitle {
            if self.feed_title.is_none() {
                self.feed_title = clean_text(text, 120);
            }
            return;
        }
        let Some(entry) = self.current.as_mut() else {
            return;
        };
        let target = match capture {
            Capture::Title => &mut entry.title,
            Capture::Summary => &mut entry.summary,
            Capture::Link => &mut entry.text_link,
            Capture::Identifier => &mut entry.identifier,
            Capture::Published => &mut entry.published,
            Capture::Updated => &mut entry.updated,
            Capture::LastModified => &mut entry.last_modified,
            Capture::Image => &mut entry.image,
            Capture::PublicationName => &mut entry.publication_name,
            Capture::FeedTitle => unreachable!(),
        };
        if target.is_none() {
            *target = Some(text.to_owned());
        }
    }

    fn finish_entry(&mut self, base_url: &Url) {
        let Some(entry) = self.current.take() else {
            return;
        };
        let kind = self.kind.expect("entry requires a feed kind");
        let raw_link = match kind {
            ConnectorKind::Atom => entry
                .atom_links
                .iter()
                .find(|(rel, _)| rel.as_deref().is_none_or(|rel| rel == "alternate"))
                .or_else(|| entry.atom_links.first())
                .map(|(_, href)| href.as_str())
                .or(entry.text_link.as_deref())
                .or(entry.identifier.as_deref()),
            ConnectorKind::Rss => entry.text_link.as_deref().or(entry.identifier.as_deref()),
            ConnectorKind::NewsSitemap => entry.text_link.as_deref(),
        };
        let Some(canonical_url) = raw_link.and_then(|value| canonicalize_url(value, base_url))
        else {
            return;
        };
        let fallback_title = (kind == ConnectorKind::NewsSitemap)
            .then(|| sitemap_fallback_title(&canonical_url))
            .flatten();
        let Some(title) = entry
            .title
            .as_deref()
            .and_then(|value| clean_text(value, 350))
            .or(fallback_title)
        else {
            return;
        };
        if self.feed_title.is_none() {
            self.feed_title = entry
                .publication_name
                .as_deref()
                .and_then(|value| clean_text(value, 120));
        }
        let published_at = normalize_date(
            entry
                .published
                .as_deref()
                .or(entry.last_modified.as_deref()),
        );
        let updated_at =
            normalize_date(entry.updated.as_deref().or(entry.last_modified.as_deref()));
        self.items.push(ParsedFeedItem {
            canonical_url,
            title,
            summary: entry
                .summary
                .as_deref()
                .and_then(|value| clean_text(value, 700)),
            image_url: entry
                .image
                .as_deref()
                .and_then(|value| resolve_http_url(value, base_url)),
            published_at,
            updated_at,
        });
    }
}

#[cfg(test)]
fn parse_feed_document(bytes: &[u8], base_url: &Url) -> Result<ParsedFeed, ApiError> {
    parse_feed_document_with_cancel(bytes, base_url, &CancellationToken::new())
}

fn parse_feed_document_with_cancel(
    bytes: &[u8],
    base_url: &Url,
    cancellation: &CancellationToken,
) -> Result<ParsedFeed, ApiError> {
    if bytes.is_empty() || bytes.len() > MAX_RESPONSE_BYTES {
        return Err(ApiError::invalid(
            "Le flux XML est vide ou trop volumineux.",
        ));
    }
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().check_comments = true;
    reader.config_mut().check_end_names = true;
    let mut state = ParseState::new();
    let mut event_count = 0usize;
    loop {
        if event_count.is_multiple_of(1_024) && cancellation.is_cancelled() {
            return Err(ApiError::cancelled());
        }
        if event_count >= MAX_XML_EVENTS {
            return Err(ApiError::invalid("Le flux contient trop d'événements XML."));
        }
        event_count += 1;
        let event = reader
            .read_event()
            .map_err(|_| ApiError::invalid("Le contenu reçu n'est pas un XML valide."))?;
        match event {
            Event::Decl(declaration) => validate_declaration(&mut state, &declaration)?,
            Event::DocType(_) => {
                return Err(ApiError::invalid(
                    "Les déclarations XML DOCTYPE et ENTITY sont interdites.",
                ));
            }
            Event::PI(_) => {
                return Err(ApiError::invalid(
                    "Les instructions de traitement XML sont interdites.",
                ));
            }
            Event::Start(element) => {
                state.structural_seen = true;
                state.consume_node()?;
                consume_attributes(&mut state, &reader, &element)?;
                let local_name = local_name(element.name().as_ref())?;
                let capture = state.capture_for(&local_name);
                state.begin_element(&local_name)?;
                state.frames.push(Frame {
                    local_name,
                    capture,
                    text: String::new(),
                });
                if state.frames.len() > MAX_XML_DEPTH {
                    return Err(ApiError::invalid("Le flux XML est trop profond."));
                }
                handle_element_attributes(&mut state, &reader, &element)?;
            }
            Event::Empty(element) => {
                state.structural_seen = true;
                state.consume_node()?;
                consume_attributes(&mut state, &reader, &element)?;
                let local_name = local_name(element.name().as_ref())?;
                state.begin_element(&local_name)?;
                handle_element_attributes(&mut state, &reader, &element)?;
                if state.frames.is_empty() {
                    state.root_closed = true;
                }
            }
            Event::End(element) => {
                let local_name = local_name(element.name().as_ref())?;
                let frame = state
                    .frames
                    .pop()
                    .ok_or_else(|| ApiError::invalid("Balise XML fermante inattendue."))?;
                if frame.local_name != local_name {
                    return Err(ApiError::invalid("Les balises XML sont mal imbriquées."));
                }
                if let Some(capture) = frame.capture {
                    state.finish_capture(capture, frame.text);
                }
                let closes_entry = matches!(
                    (state.kind, local_name.as_str()),
                    (Some(ConnectorKind::Rss), "item")
                        | (Some(ConnectorKind::Atom), "entry")
                        | (Some(ConnectorKind::NewsSitemap), "url")
                );
                if closes_entry {
                    state.finish_entry(base_url);
                }
                if state.frames.is_empty() {
                    state.root_closed = true;
                }
            }
            Event::Text(text) => {
                let decoded = text
                    .decode()
                    .map_err(|_| ApiError::invalid("Encodage XML invalide."))?;
                if !decoded.trim().is_empty() {
                    if state.frames.is_empty() {
                        return Err(ApiError::invalid("Texte XML hors de la racine."));
                    }
                    state.structural_seen = true;
                }
                append_to_active_capture(&mut state.frames, &decoded);
            }
            Event::CData(text) => {
                if state.frames.is_empty() {
                    return Err(ApiError::invalid("CDATA XML hors de la racine."));
                }
                state.structural_seen = true;
                state.consume_node()?;
                let decoded = text
                    .decode()
                    .map_err(|_| ApiError::invalid("Encodage CDATA invalide."))?;
                append_to_active_capture(&mut state.frames, &decoded);
            }
            Event::Comment(_) => {
                state.structural_seen = true;
                state.consume_node()?;
            }
            Event::Eof => break,
            Event::GeneralRef(reference) => {
                if state.frames.is_empty() {
                    return Err(ApiError::invalid("Référence XML hors de la racine."));
                }
                let decoded = reference
                    .decode()
                    .map_err(|_| ApiError::invalid("Référence XML invalide."))?;
                let replacement = match decoded.as_ref() {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "apos" => Some('\''),
                    "quot" => Some('"'),
                    _ => reference
                        .resolve_char_ref()
                        .map_err(|_| ApiError::invalid("Référence XML invalide."))?,
                }
                .ok_or_else(|| ApiError::invalid("Entité XML non autorisée."))?;
                let mut encoded = [0u8; 4];
                append_to_active_capture(&mut state.frames, replacement.encode_utf8(&mut encoded));
            }
        }
    }
    if !state.frames.is_empty() || state.current.is_some() || !state.root_closed {
        return Err(ApiError::invalid("Le flux XML est incomplet."));
    }
    let kind = state
        .kind
        .ok_or_else(|| ApiError::invalid("Aucun flux RSS, Atom ou Sitemap n'a été trouvé."))?;
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut deduplicated: Vec<ParsedFeedItem> = Vec::with_capacity(state.items.len());
    for item in state.items {
        if let Some(position) = positions.get(&item.canonical_url).copied() {
            let existing = &mut deduplicated[position];
            if existing.summary.is_none() && item.summary.is_some() {
                *existing = item;
            }
        } else {
            positions.insert(item.canonical_url.clone(), deduplicated.len());
            deduplicated.push(item);
        }
    }
    Ok(ParsedFeed {
        kind,
        title: state.feed_title,
        items: deduplicated,
    })
}

fn validate_declaration(
    state: &mut ParseState,
    declaration: &BytesDecl<'_>,
) -> Result<(), ApiError> {
    state.consume_node()?;
    if state.declaration_seen
        || state.structural_seen
        || declaration.len().saturating_add(4) > MAX_XML_DECLARATION_BYTES
    {
        return Err(ApiError::invalid(
            "Seule une déclaration XML courte au début du document est autorisée.",
        ));
    }
    let version = declaration
        .xml_version()
        .map_err(|_| ApiError::invalid("Version XML invalide."))?;
    if let Some(encoding) = declaration.encoding() {
        let encoding = encoding.map_err(|_| ApiError::invalid("Encodage XML invalide."))?;
        let valid = encoding.first().is_some_and(u8::is_ascii_alphabetic)
            && encoding
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte));
        if !valid {
            return Err(ApiError::invalid("Encodage XML invalide."));
        }
    }
    if let Some(standalone) = declaration.standalone() {
        let standalone = standalone.map_err(|_| ApiError::invalid("Déclaration XML invalide."))?;
        if !matches!(standalone.as_ref(), b"yes" | b"no") {
            return Err(ApiError::invalid("Déclaration XML invalide."));
        }
    }
    state.declaration_seen = true;
    state.xml_version = version;
    Ok(())
}

fn consume_attributes(
    state: &mut ParseState,
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
) -> Result<(), ApiError> {
    for attribute in element.attributes().with_checks(true) {
        let attribute = attribute.map_err(|_| ApiError::invalid("Attribut XML invalide."))?;
        state.attributes += 1;
        if state.attributes > MAX_XML_ATTRIBUTES {
            return Err(ApiError::invalid("Le flux contient trop d'attributs XML."));
        }
        attribute
            .decoded_and_normalized_value(state.xml_version, reader.decoder())
            .map_err(|_| ApiError::invalid("Valeur d'attribut XML invalide."))?;
    }
    Ok(())
}

fn handle_element_attributes(
    state: &mut ParseState,
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
) -> Result<(), ApiError> {
    let Some(entry) = state.current.as_mut() else {
        return Ok(());
    };
    let element_name = local_name(element.name().as_ref())?;
    let mut values = HashMap::new();
    for attribute in element.attributes().with_checks(true) {
        let attribute = attribute.map_err(|_| ApiError::invalid("Attribut XML invalide."))?;
        let key = local_name(attribute.key.as_ref())?;
        let value = attribute
            .decoded_and_normalized_value(state.xml_version, reader.decoder())
            .map_err(|_| ApiError::invalid("Valeur d'attribut XML invalide."))?;
        if value.len() <= MAX_HTTP_URL_LENGTH {
            values.insert(key, value.into_owned());
        }
    }
    match element_name.as_str() {
        "link" => {
            if let Some(href) = values.get("href") {
                entry
                    .atom_links
                    .push((values.get("rel").cloned(), href.clone()));
            }
        }
        "enclosure" => {
            let is_image = values
                .get("type")
                .is_none_or(|kind| kind.is_empty() || kind.starts_with("image/"));
            if is_image && entry.image.is_none() {
                entry.image = values.get("url").cloned();
            }
        }
        "thumbnail" => {
            if entry.image.is_none() {
                entry.image = values.get("url").or_else(|| values.get("href")).cloned();
            }
        }
        "content" => {
            let is_image = values
                .get("type")
                .is_some_and(|kind| kind.starts_with("image/"));
            if is_image && entry.image.is_none() {
                entry.image = values.get("url").or_else(|| values.get("src")).cloned();
            }
        }
        _ => {}
    }
    Ok(())
}

fn append_to_active_capture(frames: &mut [Frame], value: &str) {
    let Some(frame) = frames
        .iter_mut()
        .rev()
        .find(|frame| frame.capture.is_some())
    else {
        return;
    };
    let remaining = MAX_FIELD_BYTES.saturating_sub(frame.text.len());
    if remaining == 0 {
        return;
    }
    let end = value
        .char_indices()
        .take_while(|(index, character)| index + character.len_utf8() <= remaining)
        .last()
        .map_or(0, |(index, character)| index + character.len_utf8());
    frame.text.push_str(&value[..end]);
}

fn local_name(bytes: &[u8]) -> Result<String, ApiError> {
    let name = std::str::from_utf8(bytes)
        .map_err(|_| ApiError::invalid("Nom XML invalide."))?
        .rsplit(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name.is_empty() {
        return Err(ApiError::invalid("Nom XML vide."));
    }
    Ok(name)
}

fn resolve_http_url(value: &str, base_url: &Url) -> Option<String> {
    if value.len() > MAX_HTTP_URL_LENGTH {
        return None;
    }
    let url = base_url.join(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.as_str().len() > MAX_HTTP_URL_LENGTH
    {
        return None;
    }
    Some(url.to_string())
}

fn canonicalize_url(value: &str, base_url: &Url) -> Option<String> {
    let resolved = resolve_http_url(value, base_url)?;
    let mut url = Url::parse(&resolved).ok()?;
    url.set_fragment(None);
    let mut parameters = url
        .query_pairs()
        .filter(|(key, _)| !is_tracking_parameter(key))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    parameters.sort();
    url.set_query(None);
    if !parameters.is_empty() {
        url.query_pairs_mut().extend_pairs(parameters);
    }
    (url.as_str().len() <= MAX_HTTP_URL_LENGTH).then(|| url.to_string())
}

fn is_tracking_parameter(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.starts_with("utm_")
        || matches!(
            key.as_str(),
            "fbclid"
                | "gclid"
                | "dclid"
                | "msclkid"
                | "mc_cid"
                | "mc_eid"
                | "oly_anon_id"
                | "oly_enc_id"
        )
}

fn clean_text(value: &str, limit: usize) -> Option<String> {
    let mut clean = String::new();
    let mut in_markup = false;
    let mut whitespace = false;
    for character in value.chars().take(MAX_FIELD_BYTES) {
        match character {
            '<' => in_markup = true,
            '>' if in_markup => {
                in_markup = false;
                whitespace = true;
            }
            _ if in_markup => {}
            _ if character.is_whitespace() => whitespace = !clean.is_empty(),
            _ => {
                if whitespace
                    && !matches!(
                        character,
                        '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}'
                    )
                {
                    clean.push(' ');
                }
                whitespace = false;
                clean.push(character);
            }
        }
    }
    let clean = clean.trim();
    if clean.is_empty() {
        return None;
    }
    if clean.chars().count() <= limit {
        return Some(clean.to_owned());
    }
    let mut shortened = clean
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    shortened = shortened.trim_end().to_owned();
    shortened.push('…');
    Some(shortened)
}

fn normalize_date(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    DateTime::parse_from_rfc3339(value)
        .or_else(|_| DateTime::parse_from_rfc2822(value))
        .ok()
        .map(|date| {
            date.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
}

fn sitemap_fallback_title(url: &str) -> Option<String> {
    let url = Url::parse(url).ok()?;
    let segment = url.path_segments()?.rfind(|segment| !segment.is_empty())?;
    clean_text(&segment.replace(['-', '_'], " "), 350)
}

#[cfg(test)]
mod tests {
    use super::{
        discover_feed_urls, is_public_ip, normalize_feed_url, parse_feed_document,
        response_looks_like_html, validate_feed_validators, validated_public_addresses,
        ConnectorKind, FeedProbeRequest, FeedTransport, FeedValidators, OriginSlots,
        MAX_HTML_DISCOVERY_ATTRIBUTES, MAX_REQUESTS_PER_ORIGIN, MAX_XML_DEPTH, MAX_XML_EVENTS,
    };
    use std::net::{IpAddr, SocketAddr};
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;
    use url::Url;

    fn base() -> Url {
        Url::parse("https://news.example/feed.xml").unwrap()
    }

    #[test]
    #[ignore = "requiert le réseau public réel"]
    fn live_reference_feeds_are_parseable_by_the_rust_transport() {
        tauri::async_runtime::block_on(async {
            let transport = FeedTransport::new().expect("transport Rust");
            for (label, url) in [
                ("Le Monde", "https://www.lemonde.fr/rss/en_continu.xml"),
                (
                    "Le Figaro",
                    "https://www.lefigaro.fr/rss/figaro_flash-actu.xml",
                ),
                ("Le Parisien", "https://feeds.leparisien.fr/leparisien/rss"),
            ] {
                let result = transport
                    .probe(
                        FeedProbeRequest {
                            url: url.to_owned(),
                            connector_kind: None,
                        },
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap_or_else(|error| panic!("{label}: {}", error.message));
                assert!(result.item_count > 0, "{label}: flux vide");
            }
        });
    }

    #[test]
    fn classifies_special_addresses_and_ipv4_mapped_ipv6() {
        for address in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                !is_public_ip(address.parse::<IpAddr>().unwrap()),
                "{address}"
            );
        }
        for address in [
            "8.8.8.8",
            "1.1.1.1",
            "2606:4700:4700::1111",
            "::ffff:8.8.8.8",
        ] {
            assert!(
                is_public_ip(address.parse::<IpAddr>().unwrap()),
                "{address}"
            );
        }
    }

    #[test]
    fn dns_rejects_a_mixed_public_private_answer() {
        let addresses = vec![
            SocketAddr::new("8.8.8.8".parse().unwrap(), 0),
            SocketAddr::new("127.0.0.1".parse().unwrap(), 0),
        ];
        assert!(validated_public_addresses(addresses).is_err());
    }

    #[test]
    fn url_validation_is_fail_closed() {
        for value in [
            "file:///etc/passwd",
            "https://user:secret@example.com/feed",
            "http://localhost/feed",
            "http://127.0.0.1/feed",
            "http://[::ffff:127.0.0.1]/feed",
        ] {
            assert!(normalize_feed_url(value).is_err(), "{value}");
        }
        let normalized = normalize_feed_url("https://example.com/feed#fragment").unwrap();
        assert_eq!(normalized.as_str(), "https://example.com/feed");
    }

    #[test]
    fn limits_each_origin_without_merging_ports_or_publishers() {
        let slots = OriginSlots::default();
        let first = slots
            .semaphore_for(&Url::parse("https://news.example/feed").unwrap())
            .unwrap();
        let same = slots
            .semaphore_for(&Url::parse("https://news.example/other").unwrap())
            .unwrap();
        let other_port = slots
            .semaphore_for(&Url::parse("https://news.example:8443/feed").unwrap())
            .unwrap();
        let other_publisher = slots
            .semaphore_for(&Url::parse("https://other.example/feed").unwrap())
            .unwrap();

        assert!(Arc::ptr_eq(&first, &same));
        assert!(!Arc::ptr_eq(&first, &other_port));
        assert!(!Arc::ptr_eq(&first, &other_publisher));
        assert_eq!(first.available_permits(), MAX_REQUESTS_PER_ORIGIN);
        let _one = first.clone().try_acquire_owned().unwrap();
        let _two = first.clone().try_acquire_owned().unwrap();
        assert!(first.clone().try_acquire_owned().is_err());
    }

    #[test]
    fn rejects_oversized_or_malformed_conditional_validators() {
        assert!(validate_feed_validators(&FeedValidators {
            etag: Some("\"revision-1\"".to_owned()),
            last_modified: Some("Wed, 15 Jul 2026 08:00:00 GMT".to_owned()),
        })
        .is_ok());
        for invalid in ["", "value\nsmuggled", &"x".repeat(1_025)] {
            assert!(validate_feed_validators(&FeedValidators {
                etag: Some(invalid.to_owned()),
                last_modified: None,
            })
            .is_err());
        }
    }

    #[test]
    fn discovers_only_bounded_same_site_feed_links_from_the_head() {
        let html = br#"<!doctype html><html><head>
          <script>const fake = '<link rel="alternate" type="application/rss+xml" href="/fake.xml">';</script>
          <link REL='alternate stylesheet' TYPE='application/rss+xml' href='/Feeds/News.XML?A=One&amp;b=2'>
          <link rel='alternate' type='application/atom+xml' href='https://feeds.news.example/atom.xml'>
          <link rel='alternate' type='application/rss+xml' href='https://attacker.example/feed.xml'>
        </head><body><link rel='alternate' type='application/rss+xml' href='/body.xml'></body></html>"#;
        assert!(response_looks_like_html(html));
        assert!(!response_looks_like_html(
            b"<rss><channel><item><description><![CDATA[<html>fragment</html>]]></description></item></channel></rss>"
        ));
        let discovered = discover_feed_urls(html, &base(), &CancellationToken::new()).unwrap();
        assert_eq!(discovered.len(), 2);
        assert_eq!(
            discovered[0].as_str(),
            "https://news.example/Feeds/News.XML?A=One&b=2"
        );
        assert_eq!(
            discovered[1].as_str(),
            "https://feeds.news.example/atom.xml"
        );
    }

    #[test]
    fn rejects_cancelled_or_attribute_bomb_html_discovery() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(discover_feed_urls(b"<html><head></head></html>", &base(), &cancellation).is_err());

        let attributes = (0..=MAX_HTML_DISCOVERY_ATTRIBUTES)
            .map(|index| format!(" a{index}='x'"))
            .collect::<String>();
        let html = format!("<html><head><meta{attributes}></head></html>");
        assert!(discover_feed_urls(html.as_bytes(), &base(), &CancellationToken::new()).is_err());
    }

    #[test]
    fn parses_rss_atom_and_news_sitemap_golden_files() {
        let rss =
            parse_feed_document(include_bytes!("../tests/fixtures/rss.xml"), &base()).unwrap();
        assert_eq!(rss.kind, ConnectorKind::Rss);
        assert_eq!(rss.title.as_deref(), Some("Le journal test"));
        assert_eq!(rss.items.len(), 1);
        assert_eq!(rss.items[0].title, "Premier & essentiel");
        assert_eq!(rss.items[0].summary.as_deref(), Some("Un résumé riche."));
        assert_eq!(
            rss.items[0].canonical_url,
            "https://news.example/articles/premier?b=2"
        );

        let atom =
            parse_feed_document(include_bytes!("../tests/fixtures/atom.xml"), &base()).unwrap();
        assert_eq!(atom.kind, ConnectorKind::Atom);
        assert_eq!(atom.items[0].canonical_url, "https://news.example/entry/1");
        assert_eq!(
            atom.items[0].updated_at.as_deref(),
            Some("2026-07-15T07:15:00.000Z")
        );

        let sitemap = parse_feed_document(
            include_bytes!("../tests/fixtures/news-sitemap.xml"),
            &base(),
        )
        .unwrap();
        assert_eq!(sitemap.kind, ConnectorKind::NewsSitemap);
        assert_eq!(sitemap.title.as_deref(), Some("Publication test"));
        assert_eq!(
            sitemap.items[0].image_url.as_deref(),
            Some("https://news.example/image.jpg")
        );
    }

    #[test]
    fn cached_parser_is_bounded_url_safe_and_matches_the_golden_parser() {
        tauri::async_runtime::block_on(async {
            let transport = FeedTransport::new().unwrap();
            let body = include_bytes!("../tests/fixtures/rss.xml").to_vec();
            let parsed = transport
                .parse_cached(
                    body,
                    "https://news.example/feed.xml",
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(parsed.kind, ConnectorKind::Rss);
            assert_eq!(parsed.items.len(), 1);
            assert_eq!(parsed.items[0].title, "Premier & essentiel");

            assert!(transport
                .parse_cached(
                    Vec::new(),
                    "https://news.example/feed.xml",
                    CancellationToken::new(),
                )
                .await
                .is_err());
            assert!(transport
                .parse_cached(
                    b"<rss/>".to_vec(),
                    "file:///tmp/feed.xml",
                    CancellationToken::new(),
                )
                .await
                .is_err());
            assert!(transport
                .parse_cached(
                    b"not XML".to_vec(),
                    "https://news.example/feed.xml",
                    CancellationToken::new(),
                )
                .await
                .is_err());
        });
    }

    #[test]
    fn rejects_declarations_entities_processing_instructions_and_depth() {
        for xml in [
            b"<!DOCTYPE rss [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><rss/>".as_slice(),
            b"<!ENTITY xxe 'boom'><rss/>".as_slice(),
            b"<?xml version='1.0'?><?target data?><rss/>".as_slice(),
            b"<rss><channel><item><title>&unknown;</title></item></channel></rss>".as_slice(),
        ] {
            assert!(parse_feed_document(xml, &base()).is_err());
        }
        let deep = format!(
            "<rss>{}<item><title>x</title><link>https://news.example/x</link></item>{}</rss>",
            "<a>".repeat(MAX_XML_DEPTH),
            "</a>".repeat(MAX_XML_DEPTH)
        );
        assert!(parse_feed_document(deep.as_bytes(), &base()).is_err());
    }

    #[test]
    fn rejects_non_structural_xml_event_floods_below_the_response_budget() {
        let entities = "&amp;".repeat(MAX_XML_EVENTS + 1);
        let xml = format!(
            "<rss><channel><noise>{entities}</noise><item><title>x</title><link>https://news.example/x</link></item></channel></rss>"
        );
        assert!(xml.len() < super::MAX_RESPONSE_BYTES);
        let error = parse_feed_document(xml.as_bytes(), &base()).unwrap_err();
        assert!(error.message.contains("événements XML"));
    }
}
