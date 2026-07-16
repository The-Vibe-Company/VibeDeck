//! Bounded, inert article extraction.
//!
//! This module deliberately does not own an HTTP client. Callers must obtain the
//! final document through the hardened transport (including proxy policy, DNS
//! checks, manual redirects and response-size accounting), then pass those bytes
//! to [`extract_article_html_with_control`]. Keeping parsing separate makes it
//! impossible for the reader to accidentally bypass the feed transport's SSRF
//! boundary.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fmt, time::Instant};
use tokio_util::sync::CancellationToken;
use url::Url;

pub(crate) const ARTICLE_READER_LIMITS: ArticleReaderLimits = ArticleReaderLimits {
    max_bytes: 2 * 1024 * 1024,
    timeout_ms: 900,
    max_elements: 30_000,
    max_attributes: 120_000,
    max_nodes: 60_000,
    max_characters: 200_000,
    max_blocks: 1_000,
    min_characters: 500,
    min_blocks: 3,
    max_text_per_block: 12_000,
    max_list_items: 100,
    max_title_length: 512,
    max_metadata_length: 1_024,
    max_url_length: 4_096,
    max_structured_data_bytes: 200_000,
    max_structured_data_nodes: 10_000,
    max_structured_data_depth: 20,
    max_static_document_bytes: 1_500_000,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ArticleReaderLimits {
    pub(crate) max_bytes: usize,
    pub(crate) timeout_ms: u64,
    pub(crate) max_elements: usize,
    pub(crate) max_attributes: usize,
    pub(crate) max_nodes: usize,
    pub(crate) max_characters: usize,
    pub(crate) max_blocks: usize,
    pub(crate) min_characters: usize,
    pub(crate) min_blocks: usize,
    pub(crate) max_text_per_block: usize,
    pub(crate) max_list_items: usize,
    pub(crate) max_title_length: usize,
    pub(crate) max_metadata_length: usize,
    pub(crate) max_url_length: usize,
    pub(crate) max_structured_data_bytes: usize,
    pub(crate) max_structured_data_nodes: usize,
    pub(crate) max_structured_data_depth: usize,
    pub(crate) max_static_document_bytes: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ReaderFallbackReason {
    UnsupportedSource,
    Paywalled,
    NotArticle,
    Blocked,
    Timeout,
    ExtractionFailed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ArticleExtractionOutcome {
    Simplified(ExtractedArticle),
    Fallback(ReaderFallbackReason),
}

impl ArticleExtractionOutcome {
    fn fallback(reason: ReaderFallbackReason) -> Self {
        Self::Fallback(reason)
    }

    #[cfg(test)]
    fn article(self) -> ExtractedArticle {
        match self {
            Self::Simplified(article) => article,
            Self::Fallback(reason) => panic!("expected an article, got {reason:?}"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractedArticle {
    pub(crate) title: String,
    pub(crate) byline: Option<String>,
    pub(crate) date: Option<String>,
    pub(crate) image_url: Option<String>,
    pub(crate) blocks: Vec<ArticleBlock>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum ArticleBlock {
    Paragraph { text: String },
    Heading { text: String },
    List { items: Vec<String> },
    Quote { text: String },
}

impl ArticleBlock {
    fn characters(&self) -> usize {
        match self {
            Self::List { items } => items.iter().map(|item| item.chars().count()).sum(),
            Self::Paragraph { text } | Self::Heading { text } | Self::Quote { text } => {
                text.chars().count()
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ArticleReaderError {
    Cancelled,
}

impl fmt::Display for ArticleReaderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("Extraction annulée."),
        }
    }
}

impl std::error::Error for ArticleReaderError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StaticReaderDocumentError {
    InvalidArticle,
    TooLarge,
}

impl fmt::Display for StaticReaderDocumentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArticle => formatter.write_str("Article simplifié invalide."),
            Self::TooLarge => formatter.write_str("Document simplifié trop volumineux."),
        }
    }
}

impl std::error::Error for StaticReaderDocumentError {}

#[derive(Clone, Copy)]
pub(crate) struct ArticleExtractionInput<'a> {
    pub(crate) connector_id: &'a str,
    pub(crate) final_url: &'a str,
    pub(crate) html: &'a [u8],
}

pub(crate) struct ArticleExtractionControl<'a> {
    cancellation: &'a CancellationToken,
    deadline: Instant,
}

impl<'a> ArticleExtractionControl<'a> {
    pub(crate) fn new(cancellation: &'a CancellationToken, deadline: Instant) -> Self {
        Self {
            cancellation,
            deadline,
        }
    }

    fn checkpoint(&self) -> Result<(), StopReason> {
        if self.cancellation.is_cancelled() {
            Err(StopReason::Cancelled)
        } else if Instant::now() >= self.deadline {
            Err(StopReason::TimedOut)
        } else {
            Ok(())
        }
    }
}

/// Convenience entry point for already-downloaded publisher HTML.
///
/// The parser is synchronous and intended to run in the existing bounded CPU
/// pool. It performs cooperative deadline and cancellation checks throughout.
pub(crate) fn extract_article_html(
    input: ArticleExtractionInput<'_>,
) -> Result<ArticleExtractionOutcome, ArticleReaderError> {
    let cancellation = CancellationToken::new();
    let deadline = Instant::now()
        .checked_add(std::time::Duration::from_millis(
            ARTICLE_READER_LIMITS.timeout_ms,
        ))
        .unwrap_or_else(Instant::now);
    extract_article_html_with_control(
        input,
        ArticleExtractionControl::new(&cancellation, deadline),
    )
}

pub(crate) fn extract_article_html_with_control(
    input: ArticleExtractionInput<'_>,
    control: ArticleExtractionControl<'_>,
) -> Result<ArticleExtractionOutcome, ArticleReaderError> {
    match extract_article_html_inner(input, &control) {
        Ok(outcome) => Ok(outcome),
        Err(ExtractFailure::Stopped(StopReason::Cancelled)) => Err(ArticleReaderError::Cancelled),
        Err(ExtractFailure::Stopped(StopReason::TimedOut)) => Ok(
            ArticleExtractionOutcome::fallback(ReaderFallbackReason::Timeout),
        ),
        Err(ExtractFailure::TooComplex) => Ok(ArticleExtractionOutcome::fallback(
            ReaderFallbackReason::NotArticle,
        )),
        Err(ExtractFailure::Malformed) => Ok(ArticleExtractionOutcome::fallback(
            ReaderFallbackReason::ExtractionFailed,
        )),
    }
}

pub(crate) fn normalize_article_url(value: &str) -> Option<Url> {
    if value.is_empty() || value.len() > ARTICLE_READER_LIMITS.max_url_length {
        return None;
    }
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return None;
    }
    Some(url)
}

pub(crate) fn create_static_reader_document(
    article: &ExtractedArticle,
) -> Result<String, StaticReaderDocumentError> {
    let article =
        normalize_typed_article(article).ok_or(StaticReaderDocumentError::InvalidArticle)?;
    let mut document = String::with_capacity(8_192);
    document.push_str("<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'\"><title>");
    push_escaped_html(&mut document, &article.title);
    document.push_str("</title><style>html{background:#11110f;color:#ece9df}body{max-width:760px;margin:0 auto;padding:40px 28px 80px;font:19px/1.65 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}h1{font-size:34px;line-height:1.18;margin:0 0 12px}h2{font-size:23px;line-height:1.3;margin:34px 0 12px}.meta{color:#aaa59a;font-size:14px;margin:0 0 28px}p,li,blockquote{max-width:68ch}blockquote{border-left:3px solid #d69b42;margin:24px 0;padding-left:18px;color:#d7d1c5}ul{padding-left:26px}</style></head><body><article><h1>");
    push_escaped_html(&mut document, &article.title);
    document.push_str("</h1>");

    let metadata = article
        .byline
        .iter()
        .chain(article.date.iter())
        .collect::<Vec<_>>();
    if !metadata.is_empty() {
        document.push_str("<p class=\"meta\">");
        for (index, value) in metadata.into_iter().enumerate() {
            if index > 0 {
                document.push_str(" · ");
            }
            push_escaped_html(&mut document, value);
        }
        document.push_str("</p>");
    }

    for block in &article.blocks {
        match block {
            ArticleBlock::Paragraph { text } => {
                document.push_str("<p>");
                push_escaped_html(&mut document, text);
                document.push_str("</p>");
            }
            ArticleBlock::Heading { text } => {
                document.push_str("<h2>");
                push_escaped_html(&mut document, text);
                document.push_str("</h2>");
            }
            ArticleBlock::Quote { text } => {
                document.push_str("<blockquote>");
                push_escaped_html(&mut document, text);
                document.push_str("</blockquote>");
            }
            ArticleBlock::List { items } => {
                document.push_str("<ul>");
                for item in items {
                    document.push_str("<li>");
                    push_escaped_html(&mut document, item);
                    document.push_str("</li>");
                }
                document.push_str("</ul>");
            }
        }
        if document.len() > ARTICLE_READER_LIMITS.max_static_document_bytes {
            return Err(StaticReaderDocumentError::TooLarge);
        }
    }
    document.push_str("</article></body></html>");
    if document.len() > ARTICLE_READER_LIMITS.max_static_document_bytes {
        return Err(StaticReaderDocumentError::TooLarge);
    }
    Ok(document)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopReason {
    Cancelled,
    TimedOut,
}

#[derive(Debug, PartialEq, Eq)]
enum ExtractFailure {
    Stopped(StopReason),
    TooComplex,
    Malformed,
}

impl From<StopReason> for ExtractFailure {
    fn from(value: StopReason) -> Self {
        Self::Stopped(value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReaderAdapter {
    Monde,
    Figaro,
    Parisien,
}

impl ReaderAdapter {
    fn for_connector(value: &str) -> Option<Self> {
        match value {
            "le-monde" => Some(Self::Monde),
            "le-figaro" => Some(Self::Figaro),
            "le-parisien" => Some(Self::Parisien),
            _ => None,
        }
    }

    fn domains(self) -> &'static [&'static str] {
        match self {
            Self::Monde => &["lemonde.fr"],
            Self::Figaro => &["lefigaro.fr"],
            Self::Parisien => &["leparisien.fr"],
        }
    }

    fn profile_accepts(self, url: &Url) -> bool {
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return false;
        }
        let Some(host) = url.host_str() else {
            return false;
        };
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        self.domains()
            .iter()
            .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
    }
}

fn extract_article_html_inner(
    input: ArticleExtractionInput<'_>,
    control: &ArticleExtractionControl<'_>,
) -> Result<ArticleExtractionOutcome, ExtractFailure> {
    control.checkpoint()?;
    let Some(adapter) = ReaderAdapter::for_connector(input.connector_id) else {
        return Ok(ArticleExtractionOutcome::fallback(
            ReaderFallbackReason::UnsupportedSource,
        ));
    };
    let Some(url) = normalize_article_url(input.final_url) else {
        return Ok(ArticleExtractionOutcome::fallback(
            ReaderFallbackReason::Blocked,
        ));
    };
    if !adapter.profile_accepts(&url) {
        return Ok(ArticleExtractionOutcome::fallback(
            ReaderFallbackReason::Blocked,
        ));
    }
    if input.html.is_empty() || input.html.len() > ARTICLE_READER_LIMITS.max_bytes {
        return Ok(ArticleExtractionOutcome::fallback(
            ReaderFallbackReason::Blocked,
        ));
    }

    let document = HtmlDocument::parse(input.html, control)?;
    control.checkpoint()?;

    let access = document.structured_access(control)?;
    if access == StructuredAccess::Premium {
        return Ok(ArticleExtractionOutcome::fallback(
            ReaderFallbackReason::Paywalled,
        ));
    }
    if adapter == ReaderAdapter::Parisien && access != StructuredAccess::Free {
        return Ok(ArticleExtractionOutcome::fallback(
            ReaderFallbackReason::Blocked,
        ));
    }

    let body_text = document.body_text(20_000, control)?;
    let body_lower = body_text.to_lowercase();
    if ["verify you are human", "access denied", "captcha"]
        .iter()
        .any(|phrase| body_lower.contains(phrase))
    {
        return Ok(ArticleExtractionOutcome::fallback(
            ReaderFallbackReason::Blocked,
        ));
    }

    let Some(root) = document.select_article_root(adapter) else {
        let reason = if body_text.chars().count() < 500 {
            ReaderFallbackReason::Blocked
        } else {
            ReaderFallbackReason::NotArticle
        };
        return Ok(ArticleExtractionOutcome::fallback(reason));
    };

    if document.has_paywall_marker(root, adapter) {
        return Ok(ArticleExtractionOutcome::fallback(
            ReaderFallbackReason::Paywalled,
        ));
    }
    if adapter != ReaderAdapter::Parisien {
        let root_text = document.text_content(root, None, 200_000, control)?;
        let root_lower = root_text.to_lowercase();
        if ["réservé aux abonnés", "abonnez-vous pour lire"]
            .iter()
            .any(|phrase| root_lower.contains(phrase))
        {
            return Ok(ArticleExtractionOutcome::fallback(
                ReaderFallbackReason::Paywalled,
            ));
        }
    }

    let removed = document.removed_nodes(root, adapter, control)?;
    let element_count = document.cleaned_element_count(root, &removed, control)?;
    if element_count == 0 || element_count > ARTICLE_READER_LIMITS.max_elements {
        return Ok(ArticleExtractionOutcome::fallback(
            ReaderFallbackReason::NotArticle,
        ));
    }

    let title_value = if let Some(value) =
        document.meta_content(&[("property", "og:title"), ("name", "twitter:title")])
    {
        Some(value)
    } else if let Some(value) = document.first_heading(root, "h1", &removed, control)? {
        Some(value)
    } else {
        document.first_global_title(adapter, control)?
    };
    let title = title_value
        .map(|value| clean_text(&value, ARTICLE_READER_LIMITS.max_title_length))
        .unwrap_or_default();
    if title.is_empty() {
        return Ok(ArticleExtractionOutcome::fallback(
            ReaderFallbackReason::NotArticle,
        ));
    }

    let byline_value = if let Some(value) =
        document.meta_content(&[("name", "author"), ("property", "article:author")])
    {
        Some(value)
    } else if let Some(value) = document.first_byline(root, adapter, &removed, control)? {
        Some(value)
    } else {
        document.first_global_byline(adapter, control)?
    };
    let byline = byline_value
        .map(|value| clean_text(&value, ARTICLE_READER_LIMITS.max_metadata_length))
        .filter(|value| !value.is_empty());
    let date = document
        .meta_content(&[("property", "article:published_time"), ("name", "date")])
        .or_else(|| document.first_time(root))
        .map(|value| clean_text(&value, ARTICLE_READER_LIMITS.max_metadata_length))
        .filter(|value| !value.is_empty());
    let image_url = document.main_image(root, &url, &removed);
    let blocks = document.extract_blocks(root, &removed, control)?;
    control.checkpoint()?;

    let article = ExtractedArticle {
        title,
        byline,
        date,
        image_url,
        blocks,
    };
    let Some(article) = normalize_typed_article(&article) else {
        return Ok(ArticleExtractionOutcome::fallback(
            ReaderFallbackReason::NotArticle,
        ));
    };
    Ok(ArticleExtractionOutcome::Simplified(article))
}

fn normalize_typed_article(value: &ExtractedArticle) -> Option<ExtractedArticle> {
    let title = clean_text(&value.title, ARTICLE_READER_LIMITS.max_title_length);
    if title.is_empty() || value.blocks.len() > ARTICLE_READER_LIMITS.max_blocks {
        return None;
    }
    let mut blocks = Vec::with_capacity(value.blocks.len());
    for block in &value.blocks {
        let normalized = match block {
            ArticleBlock::List { items } => {
                let items = items
                    .iter()
                    .take(ARTICLE_READER_LIMITS.max_list_items)
                    .map(|item| clean_text(item, ARTICLE_READER_LIMITS.max_text_per_block))
                    .filter(|item| !item.is_empty())
                    .collect::<Vec<_>>();
                if items.is_empty() {
                    continue;
                }
                ArticleBlock::List { items }
            }
            ArticleBlock::Paragraph { text } => {
                let text = clean_text(text, ARTICLE_READER_LIMITS.max_text_per_block);
                if text.is_empty() {
                    continue;
                }
                ArticleBlock::Paragraph { text }
            }
            ArticleBlock::Heading { text } => {
                let text = clean_text(text, ARTICLE_READER_LIMITS.max_text_per_block);
                if text.is_empty() {
                    continue;
                }
                ArticleBlock::Heading { text }
            }
            ArticleBlock::Quote { text } => {
                let text = clean_text(text, ARTICLE_READER_LIMITS.max_text_per_block);
                if text.is_empty() {
                    continue;
                }
                ArticleBlock::Quote { text }
            }
        };
        blocks.push(normalized);
    }
    let characters = blocks.iter().map(ArticleBlock::characters).sum::<usize>();
    if blocks.len() < ARTICLE_READER_LIMITS.min_blocks
        || !(ARTICLE_READER_LIMITS.min_characters..=ARTICLE_READER_LIMITS.max_characters)
            .contains(&characters)
    {
        return None;
    }

    Some(ExtractedArticle {
        title,
        byline: value
            .byline
            .as_deref()
            .map(|value| clean_text(value, ARTICLE_READER_LIMITS.max_metadata_length))
            .filter(|value| !value.is_empty()),
        date: value
            .date
            .as_deref()
            .map(|value| clean_text(value, ARTICLE_READER_LIMITS.max_metadata_length))
            .filter(|value| !value.is_empty()),
        image_url: value
            .image_url
            .as_deref()
            .and_then(|value| clean_https_image(value, None, ARTICLE_READER_LIMITS.max_url_length)),
        blocks,
    })
}

#[derive(Clone, Debug)]
struct HtmlNode {
    parent: Option<usize>,
    kind: HtmlNodeKind,
}

#[derive(Clone, Debug)]
enum HtmlNodeKind {
    Element(HtmlElement),
    Text(String),
}

#[derive(Clone, Debug)]
struct HtmlElement {
    tag: String,
    attributes: Vec<(String, String)>,
    children: Vec<usize>,
}

#[derive(Debug)]
struct HtmlDocument {
    nodes: Vec<HtmlNode>,
}

impl HtmlDocument {
    fn parse(bytes: &[u8], control: &ArticleExtractionControl<'_>) -> Result<Self, ExtractFailure> {
        let source = String::from_utf8_lossy(bytes);
        let bytes = source.as_bytes();
        let mut document = Self {
            nodes: vec![HtmlNode {
                parent: None,
                kind: HtmlNodeKind::Element(HtmlElement {
                    tag: "#document".to_owned(),
                    attributes: Vec::new(),
                    children: Vec::new(),
                }),
            }],
        };
        let mut stack = vec![0_usize];
        let mut cursor = 0_usize;
        let mut elements = 0_usize;
        let mut attributes = 0_usize;
        let mut tokens = 0_usize;

        while cursor < bytes.len() {
            tokens += 1;
            if tokens % 128 == 0 {
                control.checkpoint()?;
            }
            if bytes[cursor] != b'<' {
                let end = bytes[cursor..]
                    .iter()
                    .position(|byte| *byte == b'<')
                    .map_or(bytes.len(), |offset| cursor + offset);
                let raw = &source[cursor..end];
                if !raw.is_empty() {
                    document.push_text(*stack.last().unwrap_or(&0), decode_html_entities(raw))?;
                }
                cursor = end;
                continue;
            }

            if starts_with_ignore_ascii_case(bytes, cursor, b"<!--") {
                cursor = find_bytes(bytes, cursor + 4, b"-->")
                    .map_or(bytes.len(), |end| end.saturating_add(3));
                continue;
            }
            if starts_with_ignore_ascii_case(bytes, cursor, b"<!")
                || starts_with_ignore_ascii_case(bytes, cursor, b"<?")
            {
                cursor = find_byte(bytes, cursor + 2, b'>')
                    .map_or(bytes.len(), |end| end.saturating_add(1));
                continue;
            }
            if starts_with_ignore_ascii_case(bytes, cursor, b"</") {
                let mut position = cursor + 2;
                skip_ascii_whitespace(bytes, &mut position);
                let (tag, after_tag) = parse_name(bytes, position);
                cursor = find_byte(bytes, after_tag, b'>')
                    .map_or(bytes.len(), |end| end.saturating_add(1));
                if !tag.is_empty() {
                    if let Some(stack_index) = stack.iter().rposition(|node| {
                        document
                            .element(*node)
                            .is_some_and(|element| element.tag.eq_ignore_ascii_case(tag))
                    }) {
                        stack.truncate(stack_index.max(1));
                    }
                }
                continue;
            }

            let mut position = cursor + 1;
            skip_ascii_whitespace(bytes, &mut position);
            let (tag_slice, after_tag) = parse_name(bytes, position);
            if tag_slice.is_empty() {
                document.push_text(*stack.last().unwrap_or(&0), "<".to_owned())?;
                cursor += 1;
                continue;
            }
            let tag = tag_slice.to_ascii_lowercase();
            position = after_tag;
            let mut node_attributes = Vec::new();
            let mut self_closing = false;
            loop {
                skip_ascii_whitespace(bytes, &mut position);
                if position >= bytes.len() {
                    cursor = bytes.len();
                    break;
                }
                if bytes[position] == b'>' {
                    cursor = position + 1;
                    break;
                }
                if bytes[position] == b'/' && bytes.get(position + 1) == Some(&b'>') {
                    self_closing = true;
                    cursor = position + 2;
                    break;
                }
                let (name_slice, after_name) = parse_name(bytes, position);
                if name_slice.is_empty() {
                    position += 1;
                    continue;
                }
                let name = name_slice.to_ascii_lowercase();
                position = after_name;
                skip_ascii_whitespace(bytes, &mut position);
                let mut value = String::new();
                if bytes.get(position) == Some(&b'=') {
                    position += 1;
                    skip_ascii_whitespace(bytes, &mut position);
                    if let Some(quote @ (b'\'' | b'\"')) = bytes.get(position).copied() {
                        position += 1;
                        let end = find_byte(bytes, position, quote).unwrap_or(bytes.len());
                        value = decode_html_entities(&source[position..end]);
                        position = end.saturating_add(usize::from(end < bytes.len()));
                    } else {
                        let start = position;
                        while position < bytes.len()
                            && !bytes[position].is_ascii_whitespace()
                            && bytes[position] != b'>'
                        {
                            position += 1;
                        }
                        value = decode_html_entities(&source[start..position]);
                    }
                }
                attributes += 1;
                if attributes > ARTICLE_READER_LIMITS.max_attributes {
                    return Err(ExtractFailure::TooComplex);
                }
                node_attributes.push((
                    name,
                    truncate_chars(&value, ARTICLE_READER_LIMITS.max_url_length),
                ));
            }

            auto_close_optional_elements(&tag, &mut stack, &document);
            elements += 1;
            if elements > ARTICLE_READER_LIMITS.max_elements {
                return Err(ExtractFailure::TooComplex);
            }
            let parent = *stack.last().unwrap_or(&0);
            let node = document.push_element(parent, tag.clone(), node_attributes)?;

            if is_raw_text_element(&tag) && !self_closing {
                let closing = format!("</{tag}");
                if let Some(close_start) =
                    find_bytes_ignore_ascii_case(bytes, cursor, closing.as_bytes())
                {
                    if close_start > cursor {
                        document.push_text(node, source[cursor..close_start].to_owned())?;
                    }
                    cursor = find_byte(bytes, close_start + closing.len(), b'>')
                        .map_or(bytes.len(), |end| end.saturating_add(1));
                } else {
                    if cursor < bytes.len() {
                        document.push_text(node, source[cursor..].to_owned())?;
                    }
                    cursor = bytes.len();
                }
                continue;
            }
            if !self_closing && !is_void_element(&tag) {
                stack.push(node);
            }
            if document.nodes.len() > ARTICLE_READER_LIMITS.max_nodes {
                return Err(ExtractFailure::TooComplex);
            }
        }
        control.checkpoint()?;
        Ok(document)
    }

    fn push_element(
        &mut self,
        parent: usize,
        tag: String,
        attributes: Vec<(String, String)>,
    ) -> Result<usize, ExtractFailure> {
        if self.nodes.len() >= ARTICLE_READER_LIMITS.max_nodes {
            return Err(ExtractFailure::TooComplex);
        }
        let index = self.nodes.len();
        self.nodes.push(HtmlNode {
            parent: Some(parent),
            kind: HtmlNodeKind::Element(HtmlElement {
                tag,
                attributes,
                children: Vec::new(),
            }),
        });
        self.element_mut(parent)
            .ok_or(ExtractFailure::Malformed)?
            .children
            .push(index);
        Ok(index)
    }

    fn push_text(&mut self, parent: usize, value: String) -> Result<(), ExtractFailure> {
        if value.is_empty() {
            return Ok(());
        }
        if self.nodes.len() >= ARTICLE_READER_LIMITS.max_nodes {
            return Err(ExtractFailure::TooComplex);
        }
        let index = self.nodes.len();
        self.nodes.push(HtmlNode {
            parent: Some(parent),
            kind: HtmlNodeKind::Text(value),
        });
        self.element_mut(parent)
            .ok_or(ExtractFailure::Malformed)?
            .children
            .push(index);
        Ok(())
    }

    fn element(&self, index: usize) -> Option<&HtmlElement> {
        match self.nodes.get(index)?.kind {
            HtmlNodeKind::Element(ref element) => Some(element),
            HtmlNodeKind::Text(_) => None,
        }
    }

    fn element_mut(&mut self, index: usize) -> Option<&mut HtmlElement> {
        match self.nodes.get_mut(index)?.kind {
            HtmlNodeKind::Element(ref mut element) => Some(element),
            HtmlNodeKind::Text(_) => None,
        }
    }

    fn attribute<'a>(&'a self, node: usize, name: &str) -> Option<&'a str> {
        self.element(node)?
            .attributes
            .iter()
            .find(|(candidate, _)| candidate == name)
            .map(|(_, value)| value.as_str())
    }

    fn body_text(
        &self,
        maximum: usize,
        control: &ArticleExtractionControl<'_>,
    ) -> Result<String, ExtractFailure> {
        let body = self
            .element_indices()
            .find(|index| {
                self.element(*index)
                    .is_some_and(|element| element.tag == "body")
            })
            .unwrap_or(0);
        self.text_content(body, None, maximum, control)
    }

    fn structured_access(
        &self,
        control: &ArticleExtractionControl<'_>,
    ) -> Result<StructuredAccess, ExtractFailure> {
        let mut bytes = 0_usize;
        let mut access = StructuredAccess::Unknown;
        let mut scripts = 0_usize;
        for node in self.element_indices() {
            if scripts >= 32 {
                break;
            }
            if node % 128 == 0 {
                control.checkpoint()?;
            }
            let Some(element) = self.element(node) else {
                continue;
            };
            if element.tag != "script"
                || !self
                    .attribute(node, "type")
                    .is_some_and(|value| value.eq_ignore_ascii_case("application/ld+json"))
            {
                continue;
            }
            scripts += 1;
            let raw = self.raw_text(node);
            bytes = bytes.saturating_add(raw.len());
            if bytes > ARTICLE_READER_LIMITS.max_structured_data_bytes {
                break;
            }
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let mut remaining = ARTICLE_READER_LIMITS.max_structured_data_nodes;
            scan_structured_access(&value, 0, &mut remaining, &mut access);
            if access == StructuredAccess::Premium {
                return Ok(access);
            }
        }
        Ok(access)
    }

    fn raw_text(&self, root: usize) -> String {
        let mut result = String::new();
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            match self.nodes.get(node).map(|node| &node.kind) {
                Some(HtmlNodeKind::Text(text)) => result.push_str(text),
                Some(HtmlNodeKind::Element(element)) => {
                    stack.extend(element.children.iter().rev().copied());
                }
                None => {}
            }
        }
        result
    }

    fn select_article_root(&self, adapter: ReaderAdapter) -> Option<usize> {
        match adapter {
            ReaderAdapter::Monde | ReaderAdapter::Figaro => {
                if let Some(node) = self.element_indices().find(|node| {
                    self.element(*node)
                        .is_some_and(|element| element.tag == "article")
                        && self.has_ancestor_tag(*node, "main")
                }) {
                    return Some(node);
                }
            }
            ReaderAdapter::Parisien => {
                if let Some(node) = self.element_indices().find(|node| {
                    let classes = self.attribute(*node, "class").unwrap_or_default();
                    has_class(classes, "article-section")
                        && has_class(classes, "margin_bottom_article")
                }) {
                    return Some(node);
                }
            }
        }

        // The dedicated publisher root changed, but the server document still
        // exposes a standard article semantic. This is the only generic
        // fallback: it remains confined to the adapter's validated domain.
        self.element_indices()
            .find(|node| {
                self.attribute(*node, "itemprop")
                    .is_some_and(|value| value.eq_ignore_ascii_case("articleBody"))
            })
            .or_else(|| {
                self.element_indices().find(|node| {
                    self.element(*node)
                        .is_some_and(|element| element.tag == "article")
                        && self.has_ancestor_tag(*node, "main")
                })
            })
            .or_else(|| {
                self.element_indices().find(|node| {
                    self.element(*node)
                        .is_some_and(|element| element.tag == "article")
                })
            })
            .or_else(|| {
                self.element_indices().find(|node| {
                    self.element(*node)
                        .is_some_and(|element| element.tag == "main")
                })
            })
    }

    fn has_ancestor_tag(&self, node: usize, tag: &str) -> bool {
        let mut current = self.nodes.get(node).and_then(|node| node.parent);
        while let Some(index) = current {
            if self
                .element(index)
                .is_some_and(|element| element.tag == tag)
            {
                return true;
            }
            current = self.nodes.get(index).and_then(|node| node.parent);
        }
        false
    }

    fn has_ancestor_before(&self, node: usize, root: usize, tags: &[&str]) -> bool {
        let mut current = self.nodes.get(node).and_then(|node| node.parent);
        while let Some(index) = current {
            if index == root {
                return false;
            }
            if self
                .element(index)
                .is_some_and(|element| tags.contains(&element.tag.as_str()))
            {
                return true;
            }
            current = self.nodes.get(index).and_then(|node| node.parent);
        }
        false
    }

    fn has_paywall_marker(&self, root: usize, adapter: ReaderAdapter) -> bool {
        self.descendant_elements(root).any(|node| {
            let class = self.attribute(node, "class").unwrap_or_default();
            let test_id = self.attribute(node, "data-testid").unwrap_or_default();
            match adapter {
                ReaderAdapter::Monde => {
                    test_id.to_ascii_lowercase().contains("paywall")
                        || has_class(class, "paywall")
                        || has_class(class, "article__paywall")
                }
                ReaderAdapter::Figaro => {
                    test_id.to_ascii_lowercase().contains("paywall")
                        || class.to_ascii_lowercase().contains("fig-paywall")
                        || class.to_ascii_lowercase().contains("premium-content")
                }
                ReaderAdapter::Parisien => false,
            }
        })
    }

    fn removed_nodes(
        &self,
        root: usize,
        adapter: ReaderAdapter,
        control: &ArticleExtractionControl<'_>,
    ) -> Result<Vec<bool>, ExtractFailure> {
        let mut removed = vec![false; self.nodes.len()];
        let mut stack = vec![(root, false)];
        let mut visited = 0_usize;
        while let Some((node, parent_removed)) = stack.pop() {
            visited += 1;
            if visited % 128 == 0 {
                control.checkpoint()?;
            }
            let own_removed = parent_removed || self.should_remove(node, adapter);
            removed[node] = own_removed;
            if let Some(element) = self.element(node) {
                stack.extend(
                    element
                        .children
                        .iter()
                        .rev()
                        .map(|child| (*child, own_removed)),
                );
            }
        }
        Ok(removed)
    }

    fn should_remove(&self, node: usize, adapter: ReaderAdapter) -> bool {
        let Some(element) = self.element(node) else {
            return false;
        };
        if [
            "script", "style", "template", "noscript", "iframe", "embed", "object", "form",
            "audio", "video", "header", "footer", "nav", "aside",
        ]
        .contains(&element.tag.as_str())
            || self
                .attribute(node, "role")
                .is_some_and(|value| value.eq_ignore_ascii_case("complementary"))
        {
            return true;
        }
        let class = self
            .attribute(node, "class")
            .unwrap_or_default()
            .to_ascii_lowercase();
        let generic_noise = ["advert", "recommendation", "related", "share"]
            .iter()
            .any(|marker| class.contains(marker));
        match adapter {
            ReaderAdapter::Monde => {
                generic_noise
                    || self
                        .attribute(node, "data-testid")
                        .is_some_and(|value| value.to_ascii_lowercase().contains("advert"))
            }
            ReaderAdapter::Figaro => {
                generic_noise
                    || [
                        "fig-sharebar",
                        "fig-sharebar-transversal",
                        "fig-share-tools",
                        "fig-ranking-profile-container",
                    ]
                    .iter()
                    .any(|marker| class.contains(marker))
                    || self
                        .attribute(node, "data-component")
                        .is_some_and(|value| value.to_ascii_lowercase().contains("advert"))
            }
            ReaderAdapter::Parisien => generic_noise,
        }
    }

    fn cleaned_element_count(
        &self,
        root: usize,
        removed: &[bool],
        control: &ArticleExtractionControl<'_>,
    ) -> Result<usize, ExtractFailure> {
        let mut count = 0_usize;
        for node in self.descendant_elements(root) {
            if node % 128 == 0 {
                control.checkpoint()?;
            }
            if !removed.get(node).copied().unwrap_or(true) {
                count += 1;
                if count > ARTICLE_READER_LIMITS.max_elements {
                    break;
                }
            }
        }
        Ok(count)
    }

    fn meta_content(&self, selectors: &[(&str, &str)]) -> Option<String> {
        for (attribute, expected) in selectors {
            for node in self.element_indices() {
                let Some(element) = self.element(node) else {
                    continue;
                };
                if element.tag == "meta"
                    && self
                        .attribute(node, attribute)
                        .is_some_and(|value| value.eq_ignore_ascii_case(expected))
                {
                    let value = self.attribute(node, "content").unwrap_or_default();
                    if !value.trim().is_empty() {
                        return Some(value.to_owned());
                    }
                }
            }
        }
        None
    }

    fn first_heading(
        &self,
        root: usize,
        tag: &str,
        removed: &[bool],
        control: &ArticleExtractionControl<'_>,
    ) -> Result<Option<String>, ExtractFailure> {
        for node in self.descendant_elements(root) {
            if !removed.get(node).copied().unwrap_or(true)
                && self.element(node).is_some_and(|element| element.tag == tag)
            {
                let text = self.text_content(
                    node,
                    Some(removed),
                    ARTICLE_READER_LIMITS.max_title_length,
                    control,
                )?;
                if !text.is_empty() {
                    return Ok(Some(text));
                }
            }
        }
        Ok(None)
    }

    fn first_global_title(
        &self,
        adapter: ReaderAdapter,
        control: &ArticleExtractionControl<'_>,
    ) -> Result<Option<String>, ExtractFailure> {
        // Mirrors the legacy adapter order: prefer a heading in the article,
        // then one in main. Le Parisien may place its h1 immediately before the
        // dedicated article-section root.
        for scope in ["article", "main", "*"] {
            for node in self.element_indices() {
                if node % 128 == 0 {
                    control.checkpoint()?;
                }
                if self.element(node).is_none_or(|element| element.tag != "h1") {
                    continue;
                }
                let in_scope = scope == "*" || self.has_ancestor_tag(node, scope);
                if !in_scope {
                    continue;
                }
                if adapter == ReaderAdapter::Figaro
                    && scope == "*"
                    && !self.has_ancestor_tag(node, "main")
                {
                    continue;
                }
                if adapter == ReaderAdapter::Monde
                    && scope == "*"
                    && !self
                        .attribute(node, "class")
                        .is_some_and(|classes| has_class(classes, "article__title"))
                {
                    continue;
                }
                let text =
                    self.text_content(node, None, ARTICLE_READER_LIMITS.max_title_length, control)?;
                if !text.is_empty() {
                    return Ok(Some(text));
                }
            }
        }
        Ok(None)
    }

    fn first_byline(
        &self,
        root: usize,
        adapter: ReaderAdapter,
        removed: &[bool],
        control: &ArticleExtractionControl<'_>,
    ) -> Result<Option<String>, ExtractFailure> {
        for node in self.descendant_elements(root) {
            if removed.get(node).copied().unwrap_or(true) {
                continue;
            }
            let rel_author = self.attribute(node, "rel").is_some_and(|value| {
                value
                    .split_ascii_whitespace()
                    .any(|part| part.eq_ignore_ascii_case("author"))
            });
            let class = self
                .attribute(node, "class")
                .unwrap_or_default()
                .to_ascii_lowercase();
            let class_author = class.contains("author")
                || (adapter == ReaderAdapter::Figaro && class.contains("fig-profile"))
                || (adapter == ReaderAdapter::Parisien && class.contains("signature"));
            if rel_author || class_author {
                let text = self.text_content(
                    node,
                    Some(removed),
                    ARTICLE_READER_LIMITS.max_metadata_length,
                    control,
                )?;
                if !text.is_empty() {
                    return Ok(Some(text));
                }
            }
        }
        Ok(None)
    }

    fn first_global_byline(
        &self,
        adapter: ReaderAdapter,
        control: &ArticleExtractionControl<'_>,
    ) -> Result<Option<String>, ExtractFailure> {
        for node in self.element_indices() {
            if node % 128 == 0 {
                control.checkpoint()?;
            }
            if adapter == ReaderAdapter::Figaro
                && !(self.has_ancestor_tag(node, "main") && self.has_ancestor_tag(node, "article"))
            {
                continue;
            }
            let rel_author = self.attribute(node, "rel").is_some_and(|value| {
                value
                    .split_ascii_whitespace()
                    .any(|part| part.eq_ignore_ascii_case("author"))
            });
            let class = self
                .attribute(node, "class")
                .unwrap_or_default()
                .to_ascii_lowercase();
            let class_author = class.contains("author")
                || (adapter == ReaderAdapter::Figaro && class.contains("fig-profile"))
                || (adapter == ReaderAdapter::Parisien && class.contains("signature"));
            if !rel_author && !class_author {
                continue;
            }
            let text = self.text_content(
                node,
                None,
                ARTICLE_READER_LIMITS.max_metadata_length,
                control,
            )?;
            if !text.is_empty() {
                return Ok(Some(text));
            }
        }
        Ok(None)
    }

    fn first_time(&self, root: usize) -> Option<String> {
        self.descendant_elements(root).find_map(|node| {
            self.element(node)
                .is_some_and(|element| element.tag == "time")
                .then(|| self.attribute(node, "datetime").map(str::to_owned))
                .flatten()
        })
    }

    fn main_image(&self, root: usize, base_url: &Url, removed: &[bool]) -> Option<String> {
        for node in self.descendant_elements(root) {
            if removed.get(node).copied().unwrap_or(true)
                || self
                    .element(node)
                    .is_none_or(|element| element.tag != "img")
            {
                continue;
            }
            let source = self
                .attribute(node, "src")
                .or_else(|| self.attribute(node, "data-src"))
                .or_else(|| {
                    self.attribute(node, "srcset")
                        .and_then(|value| value.split(',').next())
                        .and_then(|candidate| candidate.split_whitespace().next())
                });
            if let Some(image) = source.and_then(|value| {
                clean_https_image(value, Some(base_url), ARTICLE_READER_LIMITS.max_url_length)
            }) {
                return Some(image);
            }
        }
        self.meta_content(&[("property", "og:image"), ("name", "twitter:image")])
            .and_then(|value| {
                clean_https_image(&value, Some(base_url), ARTICLE_READER_LIMITS.max_url_length)
            })
    }

    fn extract_blocks(
        &self,
        root: usize,
        removed: &[bool],
        control: &ArticleExtractionControl<'_>,
    ) -> Result<Vec<ArticleBlock>, ExtractFailure> {
        let mut blocks = Vec::new();
        let mut previous = String::new();
        for node in self.descendant_elements(root) {
            if blocks.len() >= ARTICLE_READER_LIMITS.max_blocks {
                break;
            }
            if node % 128 == 0 {
                control.checkpoint()?;
            }
            if removed.get(node).copied().unwrap_or(true) {
                continue;
            }
            let Some(element) = self.element(node) else {
                continue;
            };
            let block = match element.tag.as_str() {
                "ul" | "ol" if !self.has_ancestor_before(node, root, &["ul", "ol"]) => {
                    let items = element
                        .children
                        .iter()
                        .copied()
                        .filter(|child| {
                            self.element(*child)
                                .is_some_and(|element| element.tag == "li")
                                && !removed.get(*child).copied().unwrap_or(true)
                        })
                        .take(ARTICLE_READER_LIMITS.max_list_items)
                        .map(|child| {
                            self.text_content(
                                child,
                                Some(removed),
                                ARTICLE_READER_LIMITS.max_text_per_block,
                                control,
                            )
                        })
                        .collect::<Result<Vec<_>, _>>()?
                        .into_iter()
                        .filter(|item| !item.is_empty())
                        .collect::<Vec<_>>();
                    if items.is_empty() {
                        None
                    } else {
                        Some(ArticleBlock::List { items })
                    }
                }
                "h2" | "h3" if !self.has_ancestor_before(node, root, &["li", "ul", "ol"]) => {
                    let text = self.text_content(
                        node,
                        Some(removed),
                        ARTICLE_READER_LIMITS.max_text_per_block,
                        control,
                    )?;
                    (!text.is_empty()).then_some(ArticleBlock::Heading { text })
                }
                "blockquote" if !self.has_ancestor_before(node, root, &["blockquote"]) => {
                    let text = self.text_content(
                        node,
                        Some(removed),
                        ARTICLE_READER_LIMITS.max_text_per_block,
                        control,
                    )?;
                    (!text.is_empty()).then_some(ArticleBlock::Quote { text })
                }
                "p" if !self.has_ancestor_before(node, root, &["li", "ul", "ol", "blockquote"]) => {
                    let text = self.text_content(
                        node,
                        Some(removed),
                        ARTICLE_READER_LIMITS.max_text_per_block,
                        control,
                    )?;
                    (!text.is_empty()).then_some(ArticleBlock::Paragraph { text })
                }
                _ => None,
            };
            let Some(block) = block else {
                continue;
            };
            let signature = match &block {
                ArticleBlock::List { items } => items.join("\u{1f}"),
                ArticleBlock::Paragraph { text }
                | ArticleBlock::Heading { text }
                | ArticleBlock::Quote { text } => text.clone(),
            };
            if signature == previous {
                continue;
            }
            previous = signature;
            blocks.push(block);
        }
        Ok(blocks)
    }

    fn text_content(
        &self,
        root: usize,
        removed: Option<&[bool]>,
        maximum: usize,
        control: &ArticleExtractionControl<'_>,
    ) -> Result<String, ExtractFailure> {
        let mut raw = String::new();
        let mut raw_characters = 0_usize;
        let mut stack = vec![root];
        let mut visited = 0_usize;
        while let Some(node) = stack.pop() {
            visited += 1;
            if visited % 128 == 0 {
                control.checkpoint()?;
            }
            if removed.is_some_and(|removed| removed.get(node).copied().unwrap_or(true)) {
                continue;
            }
            match self.nodes.get(node).map(|node| &node.kind) {
                Some(HtmlNodeKind::Text(text)) => {
                    raw.push_str(text);
                    raw.push(' ');
                    raw_characters = raw_characters
                        .saturating_add(text.chars().count())
                        .saturating_add(1);
                    if raw_characters > maximum.saturating_mul(2) {
                        break;
                    }
                }
                Some(HtmlNodeKind::Element(element)) => {
                    stack.extend(element.children.iter().rev().copied());
                }
                None => return Err(ExtractFailure::Malformed),
            }
        }
        Ok(clean_text(&raw, maximum))
    }

    fn descendant_elements(&self, root: usize) -> DescendantElements<'_> {
        DescendantElements {
            document: self,
            stack: vec![root],
        }
    }

    fn element_indices(&self) -> impl Iterator<Item = usize> + '_ {
        self.nodes.iter().enumerate().filter_map(|(index, node)| {
            matches!(node.kind, HtmlNodeKind::Element(_)).then_some(index)
        })
    }
}

struct DescendantElements<'a> {
    document: &'a HtmlDocument,
    stack: Vec<usize>,
}

impl Iterator for DescendantElements<'_> {
    type Item = usize;

    fn next(&mut self) -> Option<Self::Item> {
        while let Some(node) = self.stack.pop() {
            if let Some(element) = self.document.element(node) {
                self.stack.extend(element.children.iter().rev().copied());
                return Some(node);
            }
        }
        None
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StructuredAccess {
    Unknown,
    Free,
    Premium,
}

fn scan_structured_access(
    value: &Value,
    depth: usize,
    remaining: &mut usize,
    access: &mut StructuredAccess,
) {
    if *remaining == 0
        || depth > ARTICLE_READER_LIMITS.max_structured_data_depth
        || *access == StructuredAccess::Premium
    {
        return;
    }
    *remaining -= 1;
    match value {
        Value::Object(object) => {
            if let Some(marker) = object.get("isAccessibleForFree") {
                match marker {
                    Value::Bool(false) => *access = StructuredAccess::Premium,
                    Value::String(value) if value.trim().eq_ignore_ascii_case("false") => {
                        *access = StructuredAccess::Premium;
                    }
                    Value::Bool(true) => *access = StructuredAccess::Free,
                    Value::String(value) if value.trim().eq_ignore_ascii_case("true") => {
                        *access = StructuredAccess::Free;
                    }
                    _ => {}
                }
            }
            for child in object.values() {
                scan_structured_access(child, depth + 1, remaining, access);
                if *access == StructuredAccess::Premium {
                    break;
                }
            }
        }
        Value::Array(values) => {
            for child in values {
                scan_structured_access(child, depth + 1, remaining, access);
                if *access == StructuredAccess::Premium {
                    break;
                }
            }
        }
        _ => {}
    }
}

fn auto_close_optional_elements(tag: &str, stack: &mut Vec<usize>, document: &HtmlDocument) {
    let close = match tag {
        "p" => &["p"][..],
        "li" => &["li"][..],
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => &["h1", "h2", "h3", "h4", "h5", "h6"][..],
        _ => return,
    };
    if let Some(last) = stack.last().copied() {
        if document
            .element(last)
            .is_some_and(|element| close.contains(&element.tag.as_str()))
        {
            stack.pop();
        }
    }
}

fn is_void_element(tag: &str) -> bool {
    [
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
        "source", "track", "wbr",
    ]
    .contains(&tag)
}

fn is_raw_text_element(tag: &str) -> bool {
    matches!(tag, "script" | "style" | "template" | "noscript")
}

fn parse_name(bytes: &[u8], start: usize) -> (&str, usize) {
    let mut end = start;
    while end < bytes.len()
        && (bytes[end].is_ascii_alphanumeric() || matches!(bytes[end], b'-' | b'_' | b':'))
    {
        end += 1;
    }
    (
        std::str::from_utf8(&bytes[start..end]).unwrap_or_default(),
        end,
    )
}

fn skip_ascii_whitespace(bytes: &[u8], cursor: &mut usize) {
    while bytes
        .get(*cursor)
        .is_some_and(|byte| byte.is_ascii_whitespace())
    {
        *cursor += 1;
    }
}

fn find_byte(bytes: &[u8], start: usize, needle: u8) -> Option<usize> {
    bytes
        .get(start..)?
        .iter()
        .position(|byte| *byte == needle)
        .map(|offset| start + offset)
}

fn find_bytes(bytes: &[u8], start: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(start.min(bytes.len()));
    }
    bytes
        .get(start..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|offset| start + offset)
}

fn find_bytes_ignore_ascii_case(bytes: &[u8], start: usize, needle: &[u8]) -> Option<usize> {
    bytes
        .get(start..)?
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))
        .map(|offset| start + offset)
}

fn starts_with_ignore_ascii_case(bytes: &[u8], start: usize, needle: &[u8]) -> bool {
    bytes
        .get(start..start.saturating_add(needle.len()))
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(needle))
}

fn has_class(classes: &str, expected: &str) -> bool {
    classes
        .split_ascii_whitespace()
        .any(|class| class.eq_ignore_ascii_case(expected))
}

fn clean_text(value: &str, maximum: usize) -> String {
    let mut output = String::new();
    let mut characters = 0_usize;
    let mut needs_space = false;
    for character in value.chars() {
        if character.is_whitespace() || character == '\u{00a0}' {
            if !output.is_empty() {
                needs_space = true;
            }
            continue;
        }
        if needs_space {
            if characters >= maximum {
                break;
            }
            output.push(' ');
            characters += 1;
            needs_space = false;
        }
        if characters >= maximum {
            break;
        }
        output.push(character);
        characters += 1;
    }
    output
}

fn truncate_chars(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

fn clean_https_image(value: &str, base: Option<&Url>, maximum: usize) -> Option<String> {
    if value.is_empty() || value.len() > maximum {
        return None;
    }
    let url = match base {
        Some(base) => base.join(value).ok()?,
        None => Url::parse(value).ok()?,
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.as_str().len() > maximum
    {
        return None;
    }
    Some(url.to_string())
}

fn decode_html_entities(value: &str) -> String {
    if !value.contains('&') {
        return value.to_owned();
    }
    let mut output = String::with_capacity(value.len());
    let mut remaining = value;
    while let Some(offset) = remaining.find('&') {
        output.push_str(&remaining[..offset]);
        remaining = &remaining[offset..];
        let Some(end) = remaining
            .get(1..)
            .and_then(|tail| tail.find(';'))
            .map(|end| end + 1)
        else {
            output.push_str(remaining);
            break;
        };
        if end > 16 {
            output.push('&');
            remaining = &remaining[1..];
            continue;
        }
        let entity = &remaining[1..end];
        let decoded = if let Some(hex) = entity
            .strip_prefix("#x")
            .or_else(|| entity.strip_prefix("#X"))
        {
            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
        } else if let Some(decimal) = entity.strip_prefix('#') {
            decimal.parse::<u32>().ok().and_then(char::from_u32)
        } else {
            match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('\"'),
                "apos" => Some('\''),
                "nbsp" => Some('\u{00a0}'),
                "ndash" => Some('–'),
                "mdash" => Some('—'),
                "hellip" => Some('…'),
                "laquo" => Some('«'),
                "raquo" => Some('»'),
                "eacute" => Some('é'),
                "egrave" => Some('è'),
                "ecirc" => Some('ê'),
                "agrave" => Some('à'),
                "ccedil" => Some('ç'),
                "ocirc" => Some('ô'),
                "ucirc" => Some('û'),
                _ => None,
            }
        };
        if let Some(character) = decoded {
            output.push(character);
        } else {
            output.push_str(&remaining[..=end]);
        }
        remaining = &remaining[end + 1..];
    }
    output
}

fn push_escaped_html(output: &mut String, value: &str) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '\"' => output.push_str("&quot;"),
            '\'' => output.push_str("&#39;"),
            _ => output.push(character),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const PARAGRAPH: &str = "Contenu public structuré et vérifiable pour la lecture dédiée. Contenu public structuré et vérifiable pour la lecture dédiée. Contenu public structuré et vérifiable pour la lecture dédiée. Contenu public structuré et vérifiable pour la lecture dédiée. Contenu public structuré et vérifiable pour la lecture dédiée. Contenu public structuré et vérifiable pour la lecture dédiée.";

    fn public_html(connector: &str, premium: bool) -> String {
        let accessible = if premium { "false" } else { "true" };
        let metadata = format!(
            "<head><meta property='og:title' content='Titre {connector}'><meta name='author' content='Rédaction'><meta property='article:published_time' content='2026-07-10'><meta property='og:image' content='https://images.example.test/{connector}.jpg'><script type='application/ld+json'>{{\"@graph\":[{{\"isAccessibleForFree\":{accessible}}}]}}</script></head>"
        );
        let body = format!("<p>{PARAGRAPH}</p><h2>Intertitre</h2><p>{PARAGRAPH}</p>");
        match connector {
            "le-monde" => format!(
                "<!doctype html><html>{metadata}<body><main><article><h1>Titre Monde</h1>{body}</article></main></body></html>"
            ),
            "le-figaro" => format!(
                "<!doctype html><html>{metadata}<body><main><article><h1>Titre Figaro</h1><div class='fig-sharebar'><p>{}</p></div>{body}<div data-component='advert-slot'><p>{PARAGRAPH}</p></div></article></main></body></html>",
                "Partager ".repeat(100)
            ),
            "le-parisien" => format!(
                "<!doctype html><html>{metadata}<body><main><h1>Titre Parisien</h1><article><section class='article-section margin_bottom_article paywall-article-section'>{body}</section></article></main></body></html>"
            ),
            _ => unreachable!(),
        }
    }

    fn input<'a>(connector_id: &'a str, url: &'a str, html: &'a str) -> ArticleExtractionInput<'a> {
        ArticleExtractionInput {
            connector_id,
            final_url: url,
            html: html.as_bytes(),
        }
    }

    #[test]
    fn only_accepts_bounded_http_urls_without_credentials() {
        assert!(normalize_article_url("http://example.test/article").is_some());
        assert!(normalize_article_url("https://example.test/article").is_some());
        assert!(normalize_article_url("https://user:secret@example.test/").is_none());
        assert!(normalize_article_url("file:///tmp/article").is_none());
        assert!(
            normalize_article_url(&format!("https://example.test/{}", "x".repeat(4_096))).is_none()
        );

        let html = public_html("le-monde", false);
        assert_eq!(
            extract_article_html(input(
                "le-monde",
                "https://lemonde.fr.attacker.test/article",
                &html,
            ))
            .unwrap(),
            ArticleExtractionOutcome::Fallback(ReaderFallbackReason::Blocked)
        );
        assert_eq!(
            extract_article_html(input("le-monde", "http://www.lemonde.fr/article", &html,))
                .unwrap(),
            ArticleExtractionOutcome::Fallback(ReaderFallbackReason::Blocked)
        );
    }

    #[test]
    fn extracts_all_dedicated_publication_roots() {
        for (connector, domain) in [
            ("le-monde", "lemonde.fr"),
            ("le-figaro", "lefigaro.fr"),
            ("le-parisien", "leparisien.fr"),
        ] {
            let html = public_html(connector, false);
            let article = extract_article_html(input(
                connector,
                &format!("https://www.{domain}/article-test"),
                &html,
            ))
            .unwrap()
            .article();
            assert_eq!(article.blocks.len(), 3, "{connector}");
            assert_eq!(article.byline.as_deref(), Some("Rédaction"));
            assert!(article.image_url.is_some());
        }
    }

    #[test]
    fn parisien_requires_explicit_public_structured_access() {
        let premium = public_html("le-parisien", true);
        assert_eq!(
            extract_article_html(input(
                "le-parisien",
                "https://www.leparisien.fr/article",
                &premium,
            ))
            .unwrap(),
            ArticleExtractionOutcome::Fallback(ReaderFallbackReason::Paywalled)
        );
        let missing = public_html("le-parisien", false).replace(
            "<script type='application/ld+json'>{\"@graph\":[{\"isAccessibleForFree\":true}]}</script>",
            "",
        );
        assert_eq!(
            extract_article_html(input(
                "le-parisien",
                "https://www.leparisien.fr/article",
                &missing,
            ))
            .unwrap(),
            ArticleExtractionOutcome::Fallback(ReaderFallbackReason::Blocked)
        );
    }

    #[test]
    fn removes_sharing_advertising_and_nested_blocks() {
        let html = public_html("le-figaro", false);
        let article =
            extract_article_html(input("le-figaro", "https://www.lefigaro.fr/article", &html))
                .unwrap()
                .article();
        let serialized = serde_json::to_string(&article.blocks).unwrap();
        assert!(!serialized.contains("Partager"));
        assert_eq!(article.blocks.len(), 3);
    }

    #[test]
    fn falls_back_to_generic_article_semantics_on_a_known_domain() {
        let html = format!(
            "<html><head><meta property='og:title' content='Titre générique'></head><body><main><section itemprop='articleBody'><p>{PARAGRAPH}</p><h2>Suite</h2><p>{PARAGRAPH}</p></section></main></body></html>"
        );
        let article = extract_article_html(input(
            "le-monde",
            "https://www.lemonde.fr/nouveau-gabarit",
            &html,
        ))
        .unwrap()
        .article();
        assert_eq!(article.title, "Titre générique");
        assert_eq!(article.blocks.len(), 3);
    }

    #[test]
    fn returns_closed_fallback_reasons_for_hostile_or_invalid_documents() {
        let blocked = "<html><body>Access denied</body></html>";
        assert_eq!(
            extract_article_html(input("le-monde", "https://www.lemonde.fr/article", blocked,))
                .unwrap(),
            ArticleExtractionOutcome::Fallback(ReaderFallbackReason::Blocked)
        );
        assert_eq!(
            extract_article_html(input(
                "unknown",
                "https://example.test/article",
                "<article></article>",
            ))
            .unwrap(),
            ArticleExtractionOutcome::Fallback(ReaderFallbackReason::UnsupportedSource)
        );
        let short = "<main><article><h1>Titre</h1><p>Trop court.</p></article></main>";
        assert_eq!(
            extract_article_html(input("le-monde", "https://www.lemonde.fr/article", short,))
                .unwrap(),
            ArticleExtractionOutcome::Fallback(ReaderFallbackReason::NotArticle)
        );
        let oversized = vec![b'x'; ARTICLE_READER_LIMITS.max_bytes + 1];
        assert_eq!(
            extract_article_html(ArticleExtractionInput {
                connector_id: "le-monde",
                final_url: "https://www.lemonde.fr/article",
                html: &oversized,
            })
            .unwrap(),
            ArticleExtractionOutcome::Fallback(ReaderFallbackReason::Blocked)
        );
    }

    #[test]
    fn cancellation_is_distinct_from_the_typed_timeout_fallback() {
        let html = public_html("le-monde", false);
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert_eq!(
            extract_article_html_with_control(
                input("le-monde", "https://www.lemonde.fr/article", &html,),
                ArticleExtractionControl::new(
                    &cancellation,
                    Instant::now() + Duration::from_secs(1),
                ),
            ),
            Err(ArticleReaderError::Cancelled)
        );

        let cancellation = CancellationToken::new();
        assert_eq!(
            extract_article_html_with_control(
                input("le-monde", "https://www.lemonde.fr/article", &html,),
                ArticleExtractionControl::new(&cancellation, Instant::now()),
            )
            .unwrap(),
            ArticleExtractionOutcome::Fallback(ReaderFallbackReason::Timeout)
        );
    }

    #[test]
    fn static_document_is_inert_escaped_and_bounded() {
        let article = ExtractedArticle {
            title: "<script>alert(1)</script>".to_owned(),
            byline: Some("<img src=x>".to_owned()),
            date: Some("2026-07-10".to_owned()),
            image_url: Some("http://images.example.test/photo.jpg".to_owned()),
            blocks: vec![
                ArticleBlock::Paragraph {
                    text: format!("{PARAGRAPH}<iframe>"),
                },
                ArticleBlock::Heading {
                    text: "Le contexte".to_owned(),
                },
                ArticleBlock::Paragraph {
                    text: PARAGRAPH.to_owned(),
                },
            ],
        };
        let document = create_static_reader_document(&article).unwrap();
        assert!(document.contains("Content-Security-Policy"));
        assert!(document.contains("default-src 'none'"));
        assert!(!document.contains("<script>alert"));
        assert!(!document.contains("<iframe>"));
        assert!(!document.contains("<a "));
        assert!(!document.contains("<img "));
        assert!(document.len() <= ARTICLE_READER_LIMITS.max_static_document_bytes);
    }

    #[test]
    fn output_text_and_lists_are_normalized_to_hard_limits() {
        let article = ExtractedArticle {
            title: "T".repeat(2_000),
            byline: None,
            date: None,
            image_url: None,
            blocks: vec![
                ArticleBlock::List {
                    items: (0..150)
                        .map(|index| {
                            if index == 0 {
                                "élément ".repeat(2_000)
                            } else {
                                "élément ".repeat(100)
                            }
                        })
                        .collect(),
                },
                ArticleBlock::Heading {
                    text: "Contexte".to_owned(),
                },
                ArticleBlock::Paragraph {
                    text: PARAGRAPH.to_owned(),
                },
            ],
        };
        let normalized = normalize_typed_article(&article).unwrap();
        assert_eq!(
            normalized.title.chars().count(),
            ARTICLE_READER_LIMITS.max_title_length
        );
        let ArticleBlock::List { items } = &normalized.blocks[0] else {
            panic!("expected a list");
        };
        assert_eq!(items.len(), ARTICLE_READER_LIMITS.max_list_items);
        assert!(items
            .iter()
            .all(|item| item.chars().count() <= ARTICLE_READER_LIMITS.max_text_per_block));
    }
}
